#define main cdmhost_program_main
#include "../cdmhost/cdmhost.cpp"
#undef main
#include <cassert>
static void u32(Bytes& b, uint32_t n) { b.insert(b.end(), {uint8_t(n>>24),uint8_t(n>>16),uint8_t(n>>8),uint8_t(n)}); }
static Bytes box(const char* type, Bytes payload) { Bytes b; u32(b, payload.size()+8); b.insert(b.end(), type, type+4); b.insert(b.end(), payload.begin(), payload.end()); return b; }
static Bytes join(Bytes a, const Bytes& b) { a.insert(a.end(), b.begin(), b.end()); return a; }

static const uint8_t TEST_PIFF_UUID[16]={0xa2,0x39,0x4f,0x52,0x5a,0x9b,0x4f,0x14,0xa2,0x44,0x6c,0x42,0x7c,0x64,0x8d,0xf4};

// This mock checks what reaches the CDM; it does not simulate licensed Widevine.
class RecordingCdm : public cdm::ContentDecryptionModule_10 {
public:
    int calls=0; Bytes iv, kid; cdm::EncryptionScheme scheme; cdm::Status result=cdm::kSuccess; std::vector<cdm::SubsampleEntry> subs;
    void Initialize(bool,bool,bool) override {}
    void GetStatusForPolicy(uint32_t,const cdm::Policy&) override {}
    void SetServerCertificate(uint32_t,const uint8_t*,uint32_t) override {}
    void CreateSessionAndGenerateRequest(uint32_t,cdm::SessionType,cdm::InitDataType,const uint8_t*,uint32_t) override {}
    void LoadSession(uint32_t,cdm::SessionType,const char*,uint32_t) override {}
    void UpdateSession(uint32_t,const char*,uint32_t,const uint8_t*,uint32_t) override {}
    void CloseSession(uint32_t,const char*,uint32_t) override {}
    void RemoveSession(uint32_t,const char*,uint32_t) override {}
    void TimerExpired(void*) override {}
    cdm::Status Decrypt(const cdm::InputBuffer_2& in,cdm::DecryptedBlock* out) override {
        ++calls; iv.assign(in.iv,in.iv+in.iv_size); kid.assign(in.key_id,in.key_id+in.key_id_size); scheme=in.encryption_scheme;
        subs.clear(); for (uint32_t i=0;i<in.num_subsamples;++i) subs.push_back(in.subsamples[i]);
        if (result != cdm::kSuccess) return result;
        auto* b=new HBuffer(in.data_size); for(uint32_t i=0;i<in.data_size;++i) b->Data()[i]=in.data[i]^0xff;
        b->SetSize(in.data_size); out->SetDecryptedBuffer(b); return cdm::kSuccess;
    }
    cdm::Status InitializeAudioDecoder(const cdm::AudioDecoderConfig_2&) override {return cdm::kInitializationError;}
    cdm::Status InitializeVideoDecoder(const cdm::VideoDecoderConfig_2&) override {assert(false);return cdm::kInitializationError;}
    void DeinitializeDecoder(cdm::StreamType) override {}
    void ResetDecoder(cdm::StreamType) override {}
    cdm::Status DecryptAndDecodeFrame(const cdm::InputBuffer_2&,cdm::VideoFrame*) override {assert(false);return cdm::kDecodeError;}
    cdm::Status DecryptAndDecodeSamples(const cdm::InputBuffer_2&,cdm::AudioFrames*) override {assert(false);return cdm::kDecodeError;}
    void OnPlatformChallengeResponse(const cdm::PlatformChallengeResponse&) override {}
    void OnQueryOutputProtectionStatus(cdm::QueryResult,uint32_t,uint32_t) override {}
    void OnStorageId(uint32_t,const uint8_t*,uint32_t) override {}
    void Destroy() override {}
};
static void test_encryption_metadata() {
    RecordingCdm cdm; g_cdm=&cdm;
    Track track; track.protected_=true; track.iv_size=8; track.scheme=0x63656e63;
    auto fragment=[](const Bytes& metadata, uint32_t samples=1, uint32_t description=0) {
        Bytes tfhd; u32(tfhd,0x20010|(description?2:0)); u32(tfhd,1); if(description)u32(tfhd,description);u32(tfhd,4);
        Bytes trun;u32(trun,1);u32(trun,samples);u32(trun,0);
        auto moof=[&](){return box("moof",box("traf",join(box("tfhd",tfhd),join(box("trun",trun),metadata))));};
        auto m=moof();trun.resize(8);u32(trun,m.size()+8);return join(moof(),box("mdat",Bytes{1,2,3,4}));
    };
    auto metadata=[](bool piff, bool override=false, uint32_t count=1) {
        Bytes body;if(piff)body.insert(body.end(),TEST_PIFF_UUID,TEST_PIFF_UUID+16);
        u32(body,override?3:2);
        if(override){body.insert(body.end(),{0,0,1,16});body.insert(body.end(),16,77);}
        u32(body,count);body.insert(body.end(),override?16:8,33);
        body.insert(body.end(),{0,1,0,0});u32(body,4); // one subsample, four cipher bytes
        return box(piff?"uuid":"senc",body);
    };
    std::string error;
    for (bool piff : {false,true}) for(bool override : {false,true}) {
        Bytes data=fragment(metadata(piff,override)), original=data; int before=cdm.calls;
        assert(decrypt_segment(track,data,error,nullptr,nullptr,0,true));assert(cdm.calls==before+1);
        assert(data.size()==original.size() && data.back()==(4^0xff));
        assert(cdm.iv[0]==33 && cdm.iv[override?15:7]==33);
        assert(cdm.kid[0]==(override?77:0));assert(cdm.scheme==cdm::EncryptionScheme::kCenc);
        assert(cdm.subs.size()==1 && cdm.subs[0].cipher_bytes==4);
        const char* marker=piff?"uuid":"senc";
        assert(std::search(data.begin(),data.end(),marker,marker+4)==data.end());
    }
    // Report the key actually passed to the CDM, including PIFF overrides, without revealing it.
    cdm.result=cdm::kNoKey;
    Bytes missingKey=fragment(metadata(true,true));
    assert(!decrypt_segment(track,missingKey,error,nullptr,nullptr,123,true));
    assert(error.find("fragment offset 123, sample 1/1; no CDM key statuses reported")!=std::string::npos);
    g_keystatus["test"]="00000000000000000000000000000000:0/sys0 ";
    missingKey=fragment(metadata(true,true));
    assert(!decrypt_segment(track,missingKey,error,nullptr,nullptr,123,true));
    assert(error.find("no reported key matches this sample")!=std::string::npos);
    g_keystatus["test"]="4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d:2/sys0 ";
    missingKey=fragment(metadata(true,true));
    assert(!decrypt_segment(track,missingKey,error,nullptr,nullptr,123,true));
    assert(error.find("matching key status(es): 2 (0=usable)")!=std::string::npos);
    assert(error.find("4d4d4d") == std::string::npos);
    g_keystatus.clear(); cdm.result=cdm::kSuccess;
    // Damaged recognized tables must fail before sending samples to the CDM.
    int before=cdm.calls;
    Bytes bad=fragment(metadata(true,false,2));assert(!decrypt_segment(track,bad,error,nullptr,nullptr,0,true));
    Bytes truncated=metadata(true);truncated.resize(truncated.size()-1);uint32_t size=truncated.size();
    truncated[0]=size>>24;truncated[1]=size>>16;truncated[2]=size>>8;truncated[3]=size;
    bad=fragment(truncated);assert(!decrypt_segment(track,bad,error,nullptr,nullptr,0,true));assert(cdm.calls==before);
    Bytes unknown(16,9);u32(unknown,0);bad=fragment(box("uuid",unknown));
    assert(!decrypt_segment(track,bad,error,nullptr,nullptr,0,true));assert(error.find("uuid:0909")!=std::string::npos);
    assert(cdm.calls==before);
    // Zero-sample trafs and explicitly selected clear descriptions need no IV table.
    Bytes empty=fragment({},0);assert(decrypt_segment(track,empty,error,nullptr,nullptr,0,true));
    track.sample_protection[2]=false;Bytes clear=fragment({},1,2), original=clear;
    assert(decrypt_segment(track,clear,error,nullptr,nullptr,0,true));assert(clear==original);
    bad=fragment({},1,3);assert(!decrypt_segment(track,bad,error,nullptr,nullptr,0,true));assert(cdm.calls==before);
    // PIFF algorithm 0 explicitly declares clear samples.
    Bytes clearTable(TEST_PIFF_UUID,TEST_PIFF_UUID+16);u32(clearTable,1);
    clearTable.insert(clearTable.end(),20,0);u32(clearTable,1);
    clear=fragment(box("uuid",clearTable));assert(decrypt_segment(track,clear,error,nullptr,nullptr,0,true));assert(cdm.calls==before);
    // Normal playback normalizes sample-description indices before reaching the CDM.
    // Its legacy path must still decrypt recognized metadata even for that clear index.
    Bytes normalized=fragment(metadata(true),1,2);before=cdm.calls;
    assert(decrypt_segment(track,normalized,error));assert(cdm.calls==before+1);
    normalized=fragment(metadata(true),1,2);before=cdm.calls;
    assert(decrypt_segment(track,normalized,error,nullptr,nullptr,0,true));assert(cdm.calls==before+1);
    g_cdm=nullptr;
}
int main() {
    test_encryption_metadata();
    Bytes frma={'a','v','c','1'}, schm(4); schm.insert(schm.end(), {'c','e','n','c'}); u32(schm,0);
    Bytes tenc(24); tenc[6]=1; tenc[7]=8;
    Bytes sinf=join(box("frma",frma),join(box("schm",schm),box("schi",box("tenc",tenc))));
    Bytes entry(78); entry[25]=16; entry[27]=16;
    entry=join(entry,box("sinf",sinf));
    Bytes sd(4); u32(sd,1); sd=join(sd,box("encv",entry));
    Bytes init=box("moov",box("trak",box("mdia",box("minf",box("stbl",box("stsd",sd))))));
    std::vector<Bytes> result;
    // g_cdm is null: decrypt-only MUST NOT initialize a video decoder.
    assert(handle(OP_SET_INIT, {Bytes{'t'},init,Bytes{'d','e','c','r','y','p','t','-','o','n','l','y'}}, result)==0);
    assert(result.size()==4 && result[0].size()==init.size() && result[2].empty());
    assert(S(result[3])=="decrypt-only");
    assert(std::search(result[0].begin(), result[0].end(), frma.begin(), frma.end())!=result[0].end());
    assert(g_tracks.at("t").protected_);
    result.clear(); assert(handle(OP_DROP_TRACK,{Bytes{'t'}},result)==0); assert(!g_tracks.count("t"));

    // Explicit tfhd base_data_offset is absolute in a full file, relative in a sliced fragment.
    Bytes tfhd; u32(tfhd,0x11); u32(tfhd,1); u32(tfhd,0); u32(tfhd,1000); u32(tfhd,4);
    Bytes trun; u32(trun,1); u32(trun,1); u32(trun,0);
    Bytes senc; u32(senc,0); u32(senc,1);
    auto makeMoof=[&](){return box("moof",box("traf",join(box("tfhd",tfhd),join(box("trun",trun),box("senc",senc)))));};
    auto moof=makeMoof(); uint32_t dataoff=moof.size()+8;
    trun.resize(8); u32(trun,dataoff); moof=makeMoof();
    Bytes segment=join(moof,box("mdat",Bytes{1,2,3,4})); Track track; track.iv_size=0;
    std::string error; Bytes correct=segment;
    assert(decrypt_segment(track,correct,error,nullptr,nullptr,1000));
    Bytes wrong=segment; assert(!decrypt_segment(track,wrong,error,nullptr,nullptr,0));
    wrong=segment; assert(!decrypt_segment(track,wrong,error,nullptr,nullptr,2000));
    tfhd.clear(); u32(tfhd,0x11); u32(tfhd,1); u32(tfhd,0); u32(tfhd,0); u32(tfhd,4);
    trun.resize(8); u32(trun,1000+dataoff); segment=join(makeMoof(),box("mdat",Bytes{1,2,3,4}));
    assert(decrypt_segment(track,segment,error,nullptr,nullptr,1000));
    Bytes missing=box("moof",box("traf",join(box("tfhd",tfhd),box("trun",trun))));
    assert(!decrypt_segment(track,missing,error,nullptr,nullptr,1000,true));
    return 0;
}
