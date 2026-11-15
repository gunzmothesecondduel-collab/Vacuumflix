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
    int calls=0; Bytes iv, kid; cdm::EncryptionScheme scheme; cdm::Pattern pattern; cdm::Status result=cdm::kSuccess; std::vector<cdm::SubsampleEntry> subs;
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
        ++calls; iv.assign(in.iv,in.iv+in.iv_size); kid.assign(in.key_id,in.key_id+in.key_id_size); scheme=in.encryption_scheme; pattern=in.pattern;
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
static void test_sample_description_keys() {
    RecordingCdm cdm; g_cdm=&cdm;
    auto entry=[](uint8_t kid) {
        Bytes frma={'a','v','c','1'}, schm(4); if(kid==22)schm.insert(schm.end(),{'c','b','c','s'});else schm.insert(schm.end(),{'c','e','n','c'});u32(schm,0);
        Bytes tenc(24); tenc[0]=kid==22?1:0; tenc[5]=kid==22?0x19:0; tenc[6]=1; tenc[7]=kid==22?16:8; std::fill(tenc.begin()+8,tenc.end(),kid);
        Bytes sinf=join(box("frma",frma),join(box("schm",schm),box("schi",box("tenc",tenc))));
        return box("encv",join(Bytes(78),box("sinf",sinf)));
    };
    Bytes sd(4);u32(sd,2);sd=join(sd,join(entry(11),entry(22)));
    Bytes tkhd(16); tkhd[15]=1;
    Bytes trak=box("trak",join(box("tkhd",tkhd),box("mdia",box("minf",box("stbl",box("stsd",sd))))));
    Bytes trex;u32(trex,0);u32(trex,1);u32(trex,1);u32(trex,0);u32(trex,0);u32(trex,0);
    Bytes init=box("moov",join(trak,box("mvex",box("trex",trex))));
    Track track;assert(process_init(init,track));
    auto fragment=[](uint32_t desc, uint32_t track_id=1) {
        Bytes tfhd;u32(tfhd,0x20010|(desc?2:0));u32(tfhd,track_id);if(desc)u32(tfhd,desc);u32(tfhd,4);
        Bytes senc;u32(senc,0);u32(senc,1);senc.insert(senc.end(),desc==2?16:8,33);
        Bytes trun;u32(trun,1);u32(trun,1);u32(trun,0);
        auto moof=[&](){return box("moof",box("traf",join(box("tfhd",tfhd),join(box("trun",trun),box("senc",senc)))));};
        auto m=moof();trun.resize(8);u32(trun,m.size()+8);return join(moof(),box("mdat",Bytes{1,2,3,4}));
    };
    std::string error;
    for (uint32_t desc : {0u,1u,2u}) {
        Bytes data=fragment(desc);
        assert(decrypt_segment(track,data,error,nullptr,nullptr,0,true));
        assert(cdm.kid[0]==(desc==2?22:11));
        assert(cdm.scheme==(desc==2?cdm::EncryptionScheme::kCbcs:cdm::EncryptionScheme::kCenc));
        assert(cdm.iv[15]==(desc==2?33:0));
        assert(cdm.pattern.crypt_byte_block==(desc==2?1u:0u));
        assert(cdm.pattern.skip_byte_block==(desc==2?9u:0u));
    }
    cdm.result=cdm::kNoKey;Bytes noKey=fragment(1);
    assert(!decrypt_segment(track,noKey,error,nullptr,nullptr,0,true));
    assert(error.find("description 1 of 2")!=std::string::npos);
    cdm.result=cdm::kSuccess;
    int before=cdm.calls;
    Bytes bad=fragment(3);assert(!decrypt_segment(track,bad,error,nullptr,nullptr,0,true));
    assert(error=="unknown MP4 sample description" && cdm.calls==before);
    Track missing=track;missing.default_descriptions.clear();bad=fragment(0);
    assert(!decrypt_segment(missing,bad,error,nullptr,nullptr,0,true));
    assert(error=="missing default MP4 sample description" && cdm.calls==before);
    Bytes empty=fragment(0);auto trun=std::search(empty.begin(),empty.end(),"trun","trun"+4);
    assert(trun!=empty.end());std::fill(trun+8,trun+12,0);
    assert(decrypt_segment(missing,empty,error,nullptr,nullptr,0,true));assert(cdm.calls==before);
    Track noMetadata=track;noMetadata.encryption[1].erase(1);bad=fragment(1);
    assert(!decrypt_segment(noMetadata,bad,error,nullptr,nullptr,0,true));
    assert(error=="missing sample description encryption metadata" && cdm.calls==before);
    Track ambiguous=track;ambiguous.ambiguous_track_ids=true;bad=fragment(1);
    assert(!decrypt_segment(ambiguous,bad,error,nullptr,nullptr,0,true));
    assert(error=="ambiguous MP4 track identifiers" && cdm.calls==before);
    bad=fragment(1,99);assert(!decrypt_segment(track,bad,error,nullptr,nullptr,0,true));
    assert(error=="unknown MP4 fragment track" && cdm.calls==before);
    Track missingId=track;missingId.descriptions[0]=missingId.descriptions.at(1);missingId.descriptions.erase(1);
    bad=fragment(1);assert(!decrypt_segment(missingId,bad,error,nullptr,nullptr,0,true));
    assert(error=="unknown MP4 fragment track" && cdm.calls==before);
    // The complete bridge path uses tfhd and trex to select keys by track.
    Bytes sd2(4);u32(sd2,1);sd2=join(sd2,entry(33));Bytes tkhd2(16);tkhd2[15]=2;
    Bytes trak2=box("trak",join(box("tkhd",tkhd2),box("mdia",box("minf",box("stbl",box("stsd",sd2))))));
    Bytes trex2;u32(trex2,0);u32(trex2,2);u32(trex2,1);u32(trex2,0);u32(trex2,0);u32(trex2,0);
    Bytes multi=box("moov",join(join(trak,trak2),box("mvex",join(box("trex",trex),box("trex",trex2)))));
    std::vector<Bytes> result;
    assert(handle(OP_SET_INIT,{Bytes{'m'},multi,Bytes{'d','e','c','r','y','p','t','-','o','n','l','y'}},result)==0);
    for(uint32_t id : {1u,2u}) {
        result.clear();assert(handle(OP_DECRYPT_SEG,{Bytes{'m'},fragment(0,id),Bytes{'0'}},result)==0);
        assert(cdm.kid[0]==(id==1?11:33));
    }
    result.clear();assert(handle(OP_DROP_TRACK,{Bytes{'m'}},result)==0);
    // Normal playback retains its original single-key handling.
    Bytes legacy=fragment(2);assert(decrypt_segment(track,legacy,error));assert(cdm.kid[0]==22);
    g_cdm=nullptr;
}
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
    test_sample_description_keys();
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
