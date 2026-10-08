/**
 * Picks the translation for a `--locale` value the way tsgo does: tsgo parses the value as a
 * BCP 47 tag with golang.org/x/text/language and takes its matcher's choice among the bundled
 * translations at Low confidence or better, falling back to English.
 *
 * The tables reproduce those results from x/text's CLDR data (likely subtags and language
 * matching) for every language that can select a translation. Tags with the Zmth (mathematical
 * notation) script are the exception: x/text's answers for them do not follow its data.
 */
import { Locale } from './diagnostic-locales.js';

/** ISO 639-2 codes of languages that can select a translation, with their canonical code. */
const languageAliases = `
  abk=ab aym=ay aze=az bel=be bre=br ces=cs chi=zh cos=co cze=cs deu=de eus=eu fra=fr fre=fr ger=de glg=gl
  grn=gn hat=ht hye=hy ita=it jpn=ja kaz=kk kin=rw kir=ky kon=kg kor=ko kur=ku lat=la lin=ln ltz=lb mlg=mg
  mon=mn oci=oc pol=pl por=pt que=qu roh=rm rus=ru spa=es tat=tt tgk=tg tuk=tk tur=tr uig=ug uzb=uz wol=wo
  zho=zh
`;

/** Bibliographic codes x/text only canonicalizes when the whole tag parses without error. */
const bibliographicAliases = 'arm=hy baq=eu';

/** The translation chosen for a language in a script, where there is one. */
const scriptMatches = `
  ab-Cyrl=12 ay-Latn=5 az-Cyrl=12 az-Latn=12 be-Cyrl=12 br-Latn=6 cmn-Hans=1 cmn-Hant=2 co-Latn=6 crs-Latn=6
  cs-Latn=3 de-Latn=4 es-Latn=5 eu-Latn=5 fr-Latn=6 gl-Latn=5 gn-Latn=5 gsw-Latn=4 ht-Latn=6 hy-Armn=12
  hy-Cyrl=12 it-Latn=7 ja-Jpan=8 kg-Latn=6 kk-Cyrl=12 ko-Kore=9 ku-Latn=13 ky-Cyrl=12 la-Latn=7 lb-Latn=4
  ln-Latn=6 lua-Latn=6 mg-Latn=6 mn-Cyrl=12 oc-Latn=6 pl-Latn=10 pt-Latn=11 qu-Latn=5 rm-Latn=4 ru-Cyrl=12
  ru-Latn=12 rw-Latn=6 tg-Cyrl=12 tk-Cyrl=12 tk-Latn=12 tr-Latn=13 tt-Cyrl=12 ug-Hans=1 ug-Hant=2 uz-Cyrl=12
  uz-Latn=12 wo-Latn=6 zh-Hans=1 zh-Hant=2
`;

/** The usual script of each language that can select a translation. */
const likelyScripts = `
  ab=Cyrl ay=Latn az=Latn be=Cyrl br=Latn cmn=Hans co=Latn crs=Latn cs=Latn de=Latn es=Latn eu=Latn fr=Latn
  gl=Latn gn=Latn gsw=Latn ht=Latn hy=Armn it=Latn ja=Jpan kg=Latn kk=Cyrl ko=Kore ku=Latn ky=Cyrl la=Latn
  lb=Latn ln=Latn lua=Latn mg=Latn mn=Cyrl oc=Latn pl=Latn pt=Latn qu=Latn rm=Latn ru=Cyrl rw=Latn tg=Cyrl
  tk=Latn tr=Latn tt=Cyrl ug=Arab uz=Latn wo=Latn zh=Hans
`;

/** Regions where a language is usually written in another script, when that changes the translation. */
const regionScripts = `
  az-034=Arab az-364=Arab az-368=Arab az-IQ=Arab az-IR=Arab cmn-003=Hant cmn-005=Hant cmn-009=Hant cmn-013=Hant
  cmn-019=Hant cmn-021=Hant cmn-035=Hant cmn-036=Hant cmn-053=Hant cmn-061=Hant cmn-096=Hant cmn-150=Hant
  cmn-154=Hant cmn-158=Hant cmn-254=Hant cmn-258=Hant cmn-344=Hant cmn-360=Hant cmn-419=Hant cmn-446=Hant
  cmn-458=Hant cmn-591=Hant cmn-608=Hant cmn-704=Hant cmn-740=Hant cmn-764=Hant cmn-826=Hant cmn-840=Hant
  cmn-967=Hant cmn-AU=Hant cmn-BN=Hant cmn-EU=Hant cmn-GB=Hant cmn-GF=Hant cmn-HK=Hant cmn-ID=Hant cmn-MO=Hant
  cmn-MY=Hant cmn-PA=Hant cmn-PF=Hant cmn-PH=Hant cmn-PZ=Hant cmn-QU=Hant cmn-SR=Hant cmn-TH=Hant cmn-TW=Hant
  cmn-UK=Hant cmn-US=Hant cmn-VD=Hant cmn-VN=Hant kk-004=Arab kk-030=Arab kk-034=Arab kk-156=Arab kk-364=Arab
  kk-496=Arab kk-AF=Arab kk-CN=Arab kk-IR=Arab kk-MN=Arab ku-422=Arab ku-LB=Arab ky-030=Arab ky-145=Latn
  ky-156=Arab ky-792=Latn ky-CN=Arab ky-TR=Latn mn-156=Mong mn-CN=Mong tg-034=Arab tg-586=Arab tg-PK=Arab
  uz-004=Arab uz-034=Arab uz-AF=Arab zh-003=Hant zh-005=Hant zh-009=Hant zh-013=Hant zh-019=Hant zh-021=Hant
  zh-035=Hant zh-036=Hant zh-053=Hant zh-061=Hant zh-096=Hant zh-150=Hant zh-154=Hant zh-158=Hant zh-254=Hant
  zh-258=Hant zh-344=Hant zh-360=Hant zh-419=Hant zh-446=Hant zh-458=Hant zh-591=Hant zh-608=Hant zh-704=Hant
  zh-740=Hant zh-764=Hant zh-826=Hant zh-840=Hant zh-967=Hant zh-AU=Hant zh-BN=Hant zh-EU=Hant zh-GB=Hant
  zh-GF=Hant zh-HK=Hant zh-ID=Hant zh-MO=Hant zh-MY=Hant zh-PA=Hant zh-PF=Hant zh-PH=Hant zh-PZ=Hant zh-QU=Hant
  zh-SR=Hant zh-TH=Hant zh-TW=Hant zh-UK=Hant zh-US=Hant zh-VD=Hant zh-VN=Hant
`;

/** For `und-REGION`: the region's usual script and translation, where there is one. */
const undRegions = `
  005=Latn:11 013=Latn:5 024=Latn:11 029=Latn:5 030=Hans:1 031=Latn:12 032=Latn:5 039=Latn:7 040=Latn:4
  051=Armn:12 068=Latn:5 076=Latn:11 112=Cyrl:12 120=Latn:6 132=Latn:11 140=Latn:6 142=Hans:1 143=Latn:12
  148=Latn:6 150=Cyrl:12 151=Cyrl:12 152=Latn:5 155=Latn:4 156=Hans:1 158=Hant:2 170=Latn:5 175=Latn:6
  178=Latn:6 188=Latn:5 192=Latn:5 203=Latn:3 204=Latn:6 214=Latn:5 218=Latn:5 222=Latn:5 226=Latn:5 249=Latn:6
  250=Latn:6 254=Latn:6 258=Latn:6 260=Latn:6 266=Latn:6 276=Latn:4 278=Latn:4 280=Latn:4 312=Latn:6 320=Latn:5
  324=Latn:6 332=Latn:6 336=Latn:7 340=Latn:5 344=Hant:2 380=Latn:7 384=Latn:6 392=Jpan:8 398=Cyrl:12 408=Kore:9
  410=Kore:9 417=Cyrl:12 419=Latn:5 438=Latn:4 442=Latn:6 446=Hant:2 450=Latn:6 474=Latn:6 484=Latn:5 492=Latn:6
  496=Cyrl:12 508=Latn:11 540=Latn:6 558=Latn:5 591=Latn:5 600=Latn:5 604=Latn:5 616=Latn:10 620=Latn:11
  624=Latn:11 626=Latn:11 630=Latn:5 638=Latn:6 643=Cyrl:12 646=Latn:6 652=Latn:6 663=Latn:6 666=Latn:6
  674=Latn:7 678=Latn:11 686=Latn:6 690=Latn:6 724=Latn:5 756=Latn:4 762=Cyrl:12 768=Latn:6 792=Latn:13
  795=Latn:12 854=Latn:6 858=Latn:5 860=Latn:12 862=Latn:5 876=Latn:6 AM=Armn:12 AO=Latn:11 AR=Latn:5 AT=Latn:4
  AZ=Latn:12 BF=Latn:6 BJ=Latn:6 BL=Latn:6 BO=Latn:5 BR=Latn:11 BY=Cyrl:12 CF=Latn:6 CG=Latn:6 CH=Latn:4
  CI=Latn:6 CL=Latn:5 CM=Latn:6 CN=Hans:1 CO=Latn:5 CR=Latn:5 CU=Latn:5 CV=Latn:11 CZ=Latn:3 DD=Latn:4 DE=Latn:4
  DO=Latn:5 DY=Latn:6 EA=Latn:5 EC=Latn:5 ES=Latn:5 EZ=Latn:4 FR=Latn:6 FX=Latn:6 GA=Latn:6 GF=Latn:6 GN=Latn:6
  GP=Latn:6 GQ=Latn:5 GT=Latn:5 GW=Latn:11 HK=Hant:2 HN=Latn:5 HT=Latn:6 HV=Latn:6 IC=Latn:5 IT=Latn:7 JP=Jpan:8
  KG=Cyrl:12 KP=Kore:9 KR=Kore:9 KZ=Cyrl:12 LI=Latn:4 LU=Latn:6 MC=Latn:6 MF=Latn:6 MG=Latn:6 MN=Cyrl:12
  MO=Hant:2 MQ=Latn:6 MX=Latn:5 MZ=Latn:11 NC=Latn:6 NI=Latn:5 PA=Latn:5 PE=Latn:5 PF=Latn:6 PL=Latn:10
  PM=Latn:6 PR=Latn:5 PT=Latn:11 PY=Latn:5 PZ=Latn:5 RE=Latn:6 RU=Cyrl:12 RW=Latn:6 SC=Latn:6 SM=Latn:7
  SN=Latn:6 ST=Latn:11 SV=Latn:5 TD=Latn:6 TF=Latn:6 TG=Latn:6 TJ=Cyrl:12 TL=Latn:11 TM=Latn:12 TP=Latn:11
  TR=Latn:13 TW=Hant:2 UY=Latn:5 UZ=Latn:12 VA=Latn:7 VE=Latn:5 WF=Latn:6 YT=Latn:6
`;

/** For `und-Script`: the translation for the script's usual language, where there is one. */
const undScripts = 'Armn=12 Cyrl=12 Hans=1 Hant=2 Jpan=8 Kore=9';

/** Tags the rules above get wrong, with x/text's answer. */
const exceptions = `
  ug-156=1 ug-158=2 ug-CN=1 ug-TW=2 und-Cyrl-008=0 und-Cyrl-070=0 und-Cyrl-100=0 und-Cyrl-300=0 und-Cyrl-498=0
  und-Cyrl-642=0 und-Cyrl-688=0 und-Cyrl-703=0 und-Cyrl-792=0 und-Cyrl-804=0 und-Cyrl-807=0 und-Cyrl-983=0
  und-Cyrl-AL=0 und-Cyrl-BA=0 und-Cyrl-BG=0 und-Cyrl-GR=0 und-Cyrl-MD=0 und-Cyrl-MK=0 und-Cyrl-RO=0
  und-Cyrl-RS=0 und-Cyrl-SK=0 und-Cyrl-TR=0 und-Cyrl-UA=0 und-Cyrl-XK=0 und-Latn-004=12 und-Latn-012=6
  und-Latn-051=13 und-Latn-150=12 und-Latn-151=12 und-Latn-174=6 und-Latn-196=13 und-Latn-268=13 und-Latn-364=12
  und-Latn-398=12 und-Latn-446=11 und-Latn-478=6 und-Latn-504=6 und-Latn-760=6 und-Latn-788=6 und-Latn-804=10
  und-Latn-AF=12 und-Latn-AM=13 und-Latn-CY=13 und-Latn-DZ=6 und-Latn-GE=13 und-Latn-IR=12 und-Latn-KM=6
  und-Latn-KZ=12 und-Latn-MA=6 und-Latn-MO=11 und-Latn-MR=6 und-Latn-SY=6 und-Latn-TN=6 und-Latn-UA=10
`;

/** Script codes x/text knows; an unknown script subtag is dropped. */
const knownScripts = `
  Adlm Afak Aghb Ahom Arab Aran Armi Armn Avst Bali Bamu Bass Batk Beng Bhks Blis Bopo Brah Brai Bugi Buhd Cakm
  Cans Cari Cham Cher Chrs Cirt Copt Cpmn Cprt Cyrl Cyrs Deva Diak Dogr Dsrt Dupl Egyd Egyh Egyp Elba Elym Ethi
  Geok Geor Glag Gong Gonm Goth Gran Grek Gujr Guru Hanb Hang Hani Hano Hans Hant Hatr Hebr Hira Hluw Hmng Hmnp
  Hrkt Hung Inds Ital Jamo Java Jpan Jurc Kali Kana Kawi Khar Khmr Khoj Kitl Kits Knda Kore Kpel Kthi Lana Laoo
  Latf Latg Latn Leke Lepc Limb Lina Linb Lisu Loma Lyci Lydi Mahj Maka Mand Mani Marc Maya Medf Mend Merc Mero
  Mlym Modi Mong Moon Mroo Mtei Mult Mymr Nagm Nand Narb Nbat Newa Nkdb Nkgb Nkoo Nshu Ogam Olck Orkh Orya Osge
  Osma Ougr Palm Pauc Pcun Pelm Perm Phag Phli Phlp Phlv Phnx Piqd Plrd Prti Psin Qaaa Qaab Qaac Qaad Qaae Qaaf
  Qaag Qaah Qaaj Qaak Qaal Qaam Qaan Qaao Qaap Qaaq Qaar Qaas Qaat Qaau Qaav Qaaw Qaax Qaay Qaaz Qaba Qabb Qabc
  Qabd Qabe Qabf Qabg Qabh Qabi Qabj Qabk Qabl Qabm Qabn Qabo Qabp Qabq Qabr Qabs Qabt Qabu Qabv Qabw Qabx Ranj
  Rjng Rohg Roro Runr Samr Sara Sarb Saur Sgnw Shaw Shrd Shui Sidd Sind Sinh Sogd Sogo Sora Soyo Sund Sunu Sylo
  Syrc Syre Syrj Syrn Tagb Takr Tale Talu Taml Tang Tavt Telu Teng Tfng Tglg Thaa Thai Tibt Tirh Tnsa Toto Ugar
  Vaii Visp Vith Wara Wcho Wole Xpeo Xsux Yezi Yiii Zanb Zinh Zmth Zsye Zsym Zxxx Zyyy Zzzz
`;

/**
 * The region codes x/text knows, as a bitset over `AA`..`ZZ` then `000`..`999` in hex. An unknown
 * region subtag is dropped.
 */
const knownRegions = `
  7d79dfeeeffddddeff3f9615c0d5001e025c0db29ffb15008d0e1c780f404023001d2bf441814ffdfdffd7276f080001403d8fd701f0
  ff430251f1fde77bbbbf9a413404778540004240c0ffffff180018044008e9f3ff13df19d137135501451111111101113ddd45444c11
  19c11145447c4c744445851510111111111115111111111111111451e4444554444444441401d1111111d11e01414444447b08141111
  5144c404854d444454047c041131111111511111119115494040781040440500418c0400000000000000fcffffffff0f
`;

/** Deprecated region codes x/text only replaces when the whole tag parses without error. */
const deprecatedRegions = 'BU CT DD DY FX HV JT MI NH NQ PU PZ QU RH TP UK VD WK YD ZR 249 278 720';

/**
 * The language codes x/text knows, as a bitset over `aa`..`zz` then `aaa`..`zzz` in hex (bit `i`
 * is bit `i % 8` of byte `i / 8`). An unknown language parses as `und`.
 */
const knownLanguages = `
  33342647c7191009645304008810681c840c09948002434490c659655c04048011f467d750180ec06d0e6da189442061404002030000
  1000c041d1ddf747749b5340040242040110000400200000004100040240f0dfffefffffffbbbdffefaf7fffc173f576b987ffffff0f
  f73bf0ffff5c502897ffdfffffffff7fffffffffffffff3f9efeffffdfc4abe0f7ffffffffff7ffffffffffffd461f0fdf75fe497100
  f2ddfff9971c82fffffffffffffffffff7ffffffffffffffff7ffff7fffffffffffffefffffffffffefffffffffbfffffffffdffbfff
  fffff7ffffefffffffffff7fffffdfffffffffffffffffeffffffffdffffbdffffeffffffffffffffff7db5fddfa07f4cf193cc4c250
  120400450400fcffefff492b5464bd498378bf777e6155d5e7c071f337fffeffdf8553860000c1fffffbffffff77e3737cfcfd1f1008
  005b000800020030000500241902fdfff7efedef45002040d69811fcbd37020000f0dde66d529e3deffffffffc4911c46008100d007f
  7cf6659de975dbfe3e0020000000007ca77d25d916e062bd47ffffff07000010c060350000004b711265a10110000000119104000006
  010000000100404400000158800100500000884200000055dd0241764332555ffd3bde3c00000800040100000040709113d07d9d1982
  798a00500024080010400000002010000440040000ebff9e032000000040000000000000020044000000200000000031aa5a00000000
  400042608a400080100805008010630804000000000474503f04814000000000be3b3b01000810010000000000000000000000f0ffff
  fffffffd3c280afcff7df2fe753e0001225b6c5a54b239f09dff3d408d0419e0107c3fc9b58d33fff7df96ffffff478000101022c1f7
  ddff50f844040440f0ffff6f8dbe417f33da000000b2972770400800ffffff0f805110080000000841cb110200000000000104408040
  eb7fca000400104942c0060006ffffff678f51f0f9ed360010010000005450eb2b884200401025feffff539080500004000000001100
  c000000000102ac0769e449108027c0479000000c00c05445278440804020110220085180190cdfe4e75d31191e6d0b73e8300005200
  140100000045649964dd7d1a7c74b90f00018000000800540410200010000408608480bf7ebf43dc690100c040100002d22d1a000000
  20410400400001df593941000810006d010400010f29c6242d10a00460440088200000020c0068008000000000008ffd5e2180000010
  0000000000110000010000f0fffffffffffffffffff7ffeffffffffffffffffffffffdffffffffffffffffefffffffffffffffffffff
  dffffffdffffffffffffffffffefbffffffffffffffffffffffffffffffffffffffeffffffffffffffffffffffdffdfdcf8b59c0f27f
  00ffffff07800030dcf761602e07ffffff472402f3b9e7d1ff7f25fffff32fef5179ffff7f04182000000254f5a9f89def167118857f
  ff7f073450108dc50500040041200000a200f8ffffffeffffffffffffffffefffffff7ffffffffffffffff7ffffffffdf7ffffffffff
  fffffffbffbffffffffffdffff7fffff7ffffffffffffffffffffffffff7fdfffb7efffffffffffffffffffffffff7ffffffffffffff
  fff7ffffe9fffffffff7ff272048f0ffffff7ffdfeff7fff2fee79fe7fff6fd7dffcfffffffffffffffffff7701a65407c09ddf56afa
  dfff3fd6b5f5ffffff0342017015255c56df24ffffff2d54585c00200240970681511004106000000000001005564010000060100102
  80512019df7fb666506970d5bedfd4b93748200604502104000040759cff05e19c6cf47d3f110300020000000900000000a000011000
  0400fffdffdbe7fbfcff2b44411806fbdfa747200090d44271f2df1efffbfe030020700ceec1fffbdfbf7fdf7fffffcfdfff7e44ff07
  111040fcf77fdf9dff5560f85e7fd7df03000030142704000400103094418200f0ffffffffffffffffffffffffffffffffffffffffff
  ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffdf7b7ee53ed195100c14
  a27f11000800000000efffff0b300200020080000000533b0e0100001041620110200033381a00051030188104000000fffdff2fa10a
  f18f2f0500080200000000042120d00304210411f6f51d03000010c02500020010002014000200f0fffffffffffff3edfddcfbfffaff
  ffb7040411dfffde7fffffbfffffff16bf17fff7fff7fffffffffffffffffddfffff7ff5ff1678f7c97fffffffffffefffff75f5f7fe
  058521f7ffff59f159f1d067dc172a59ffffffffffffffdfdffdffdf6ffffdff038429f0fffe7f6fefffffffff07ed53b1c7fbeffbff
  7fffff7ffff7ffefff7f7fddfffe02f85bfcffffffffffffffffdfffffff67f471f79fbfddf5dc6791abbe07ea010200234040824400
  0000446d400000400040000093600005800000044002400000c18d77ddf440f5146f4156ada4002400000480000000c0ffbffe818514
  44024a0000230124020001000000000010000080000801f1fb36091000000000000000000cf8020000000000a0000000007c282c0010
  0010f08f21002001ff9ff70350020080a0000000000000000400310090000200100000300800000010000000000000000000000000f0
  ffffffece71b010100201960d49cef0510000043415005114060ffa3574000000b085255f7d9f71dc78c573d547f7d46110000000000
  c072bffd410536885600b188a31b000000034042040000311023100000005fff7f7dcd0b678da7570155404a981e040000b096234507
  940e03a926090020f0fffeff573845fffeff2fdf7dcc542fc4ffffff0100086cc56cf1b97fd3f7fedf4bfa1a408411d0e5a484008502
  030e08014202f0ffffffe61f6080a80264111050b1e21300000001995624201090fefb3b000000c17d1a4de549f4ddff68365b05423d
  8e0dd303080000c0441f514cf806052002f5f7bb7d00000241285b04614004002021100100ffdfff57206091080000800000c1300000
  0000300823c0421830033c42020000b04cae63844c15ffffff671110400875c0ffffff10000004811310c02101146e67813800010000
  1000000000002042a20004080000
`;

class Tables {
  readonly aliases = pairs(languageAliases);
  readonly bibliographic = pairs(bibliographicAliases);
  readonly matches = pairs(scriptMatches);
  readonly likely = pairs(likelyScripts);
  readonly regionScripts = pairs(regionScripts);
  readonly undRegions = pairs(undRegions);
  readonly undScripts = pairs(undScripts);
  readonly exceptions = pairs(exceptions);
  readonly scripts = new Set(knownScripts.trim().split(/\s+/));
  readonly languages = hexBytes(knownLanguages.replace(/\s+/g, ''));
  readonly regions = hexBytes(knownRegions.replace(/\s+/g, ''));
  readonly deprecatedRegions = new Set(deprecatedRegions.split(' '));
}

let tables: Tables | undefined;

function pairs(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of text.trim().split(/\s+/)) {
    const equals = entry.indexOf('=');
    map.set(entry.slice(0, equals), entry.slice(equals + 1));
  }
  return map;
}

function hexBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function isLowerLetter(c: number): boolean {
  return c >= 0x61 && c <= 0x7a;
}

function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

function hasBit(bits: Uint8Array, index: number): boolean {
  return (bits[index >> 3] & (1 << (index & 7))) !== 0;
}

function isKnownLanguage(t: Tables, code: string): boolean {
  let index = 0;
  for (let i = 0; i < code.length; i++) {
    const c = code.charCodeAt(i);
    if (!isLowerLetter(c)) return false;
    index = index * 26 + (c - 0x61);
  }
  return hasBit(t.languages, code.length === 3 ? index + 26 * 26 : index);
}

/** Whether `code`, a lowercase two-character or three-digit subtag, is a region x/text knows. */
function isKnownRegion(t: Tables, code: string): boolean {
  const a = code.charCodeAt(0);
  const b = code.charCodeAt(1);
  if (code.length === 2) return isLowerLetter(a) && isLowerLetter(b) && hasBit(t.regions, (a - 0x61) * 26 + b - 0x61);
  const c = code.charCodeAt(2);
  if (!isDigit(a) || !isDigit(b) || !isDigit(c)) return false;
  return hasBit(t.regions, 26 * 26 + (a - 0x30) * 100 + (b - 0x30) * 10 + c - 0x30);
}

function toLocale(value: string | undefined): Locale {
  return value === undefined ? Locale.Default : (Number(value) as Locale);
}

/** Lowercases ASCII letters and turns `_` into `-`. */
function normalize(tag: string): string {
  let result = '';
  for (let i = 0; i < tag.length; i++) {
    const c = tag.charCodeAt(i);
    if (c >= 0x41 && c <= 0x5a) result += String.fromCharCode(c + 0x20);
    else if (c === 0x5f) result += '-';
    else result += String.fromCharCode(c);
  }
  return result;
}

function isSubtag(text: string): boolean {
  if (text.length === 0 || text.length > 8) return false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (!isLowerLetter(c) && !isDigit(c)) return false;
  }
  return true;
}

/** The translation `tsc --locale tag` uses: `Locale.Default` (English) unless a bundled one matches. */
export function parseLocale(tag: string): Locale {
  const t = (tables ??= new Tables());
  const normalized = normalize(tag);
  // Grandfathered tags whose replacement differs from what their subtags would parse to.
  if (tag.length <= 11) {
    if (normalized === 'i-lux') return Locale.DeDE;
    if (normalized === 'zh-hakka' || normalized === 'zh-xiang') return Locale.Default;
  }
  // Malformed subtags are dropped and make the tag an error.
  let error = false;
  const subtags: string[] = [];
  for (const subtag of normalized.split('-')) {
    if (isSubtag(subtag)) subtags.push(subtag);
    else error = true;
  }
  if (subtags.length === 0 || subtags[0].length < 2 || subtags[0].length > 3) return Locale.Default;

  let language = 'und';
  if (isKnownLanguage(t, subtags[0])) language = subtags[0];
  else error = true;
  let i = 1;
  // Extended language subtags replace the language.
  for (; i < subtags.length && subtags[i].length === 3 && !isDigit(subtags[i].charCodeAt(0)); i++) {
    if (isKnownLanguage(t, subtags[i])) language = subtags[i];
    else error = true;
  }
  let script = '';
  if (i < subtags.length && subtags[i].length === 4 && !isDigit(subtags[i].charCodeAt(0))) {
    const candidate = subtags[i].slice(0, 1).toUpperCase() + subtags[i].slice(1);
    if (t.scripts.has(candidate)) script = candidate;
    else error = true;
    i++;
  }
  let region = '';
  if (i < subtags.length && (subtags[i].length === 2 || subtags[i].length === 3)) {
    if (isKnownRegion(t, subtags[i])) region = subtags[i].toUpperCase();
    else error = true;
  }

  language = t.aliases.get(language) ?? language;
  if (!error) language = t.bibliographic.get(language) ?? language;
  else if (language === 'und' && t.deprecatedRegions.has(region)) region = '';
  return matchSubtags(t, language, script, region);
}

function matchSubtags(t: Tables, language: string, script: string, region: string): Locale {
  const hasScript = script.length > 0;
  const hasRegion = region.length > 0;
  const tag = language + (hasScript ? '-' + script : '') + (hasRegion ? '-' + region : '');
  const exception = t.exceptions.get(tag);
  if (exception !== undefined) return toLocale(exception);

  if (language === 'und') {
    const usual = hasRegion ? t.undRegions.get(region) : undefined;
    if (usual !== undefined) {
      const colon = usual.indexOf(':');
      if (!hasScript || usual.slice(0, colon) === script) return toLocale(usual.slice(colon + 1));
    }
    return hasScript ? toLocale(t.undScripts.get(script)) : Locale.Default;
  }
  const usualScript = hasScript
    ? script
    : (t.regionScripts.get(language + '-' + region) ?? t.likely.get(language) ?? '');
  return toLocale(t.matches.get(language + '-' + usualScript));
}
