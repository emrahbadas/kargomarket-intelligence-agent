/**
 * Metin kirpma yardimcilari.
 *
 * NEDEN AYRI BIR MODUL
 * Projede metin birden cok yerde kirpiliyordu ve hepsi `slice(0, N)`
 * kullaniyordu. Bu, cumleyi ortasindan kesiyor: "...navlun fiyatlari eylul
 * ayinda yuzde 12 ar" gibi. Yarim cumle hem okunamaz hem de sonraki
 * asamadaki modele yanlis baglam verir - model yarim kalan cumleyi kendi
 * tahminiyle tamamlar ve uydurma oradan baslar.
 *
 * Buradaki fonksiyonlar butceyi CUMLE SINIRINDA uygular: hedefi biraz
 * asmak ya da biraz altinda kalmak, cumleyi ortadan bolmekten iyidir.
 */

/** Cumle sonu sayilan noktalama. Turkce kisaltmalar icin ayrica kontrol var. */
const SENTENCE_END = /([.!?…]+)(\s|$)/g;

/**
 * Nokta her zaman cumle bitirmez: "Dr.", "vb.", "A.Ş.", "12.000" gibi
 * durumlarda bolmek metni bozar.
 */
const NOT_SENTENCE_END = /(?:\b(?:Dr|Av|Prof|Doc|Sn|vb|vs|bkz|Ltd|A\.?Ş|T\.?C|No|Nr|Mah|Cad|Sok)\.|\d\.)$/i;

/**
 * Metindeki cumle sonu konumlarini dondurur (bitis indeksi, dahil).
 */
const sentenceBoundaries = (text: string): number[] => {
  const konumlar: number[] = [];
  SENTENCE_END.lastIndex = 0;
  let eslesme: RegExpExecArray | null;

  while ((eslesme = SENTENCE_END.exec(text)) !== null) {
    const bitis = eslesme.index + eslesme[1].length;
    const oncesi = text.slice(Math.max(0, bitis - 12), bitis);
    if (NOT_SENTENCE_END.test(oncesi)) continue;
    konumlar.push(bitis);
  }

  return konumlar;
};

export interface TruncateOptions {
  /** Hedef uzunluk. */
  budget: number;
  /**
   * Butcenin ne kadar asilabilecegi (orani). Cumle biraz sonra bitiyorsa
   * kirpmak yerine esnetmek daha iyi sonuc verir.
   */
  overflowRatio?: number;
}

/**
 * Metni cumle sinirinda kirpar.
 *
 * Once butceyi ASMAYAN en son cumle sonuna bakar. Eger o nokta butcenin
 * cok altinda kaliyorsa (yarisindan az), bir sonraki cumle sonuna kadar
 * ESNETIR - boylece tek uzun cumleli metinler bastan kesilmez.
 */
export const truncateAtSentence = (text: string, options: TruncateOptions): string => {
  const { budget, overflowRatio = 0.15 } = options;
  const temiz = text.trim();
  if (temiz.length <= budget) return temiz;

  const sinirlar = sentenceBoundaries(temiz);
  if (!sinirlar.length) {
    // Hic cumle sonu yok (baslik listesi, madde isaretleri vb.):
    // en azindan kelime ortasindan bolme.
    const kesme = temiz.lastIndexOf(' ', budget);
    return `${temiz.slice(0, kesme > 0 ? kesme : budget).trim()}…`;
  }

  const butceIci = sinirlar.filter((konum) => konum <= budget);
  const enIyi = butceIci.length ? butceIci[butceIci.length - 1] : 0;

  // Butce icindeki son cumle sonu cok geride kaldiysa, bir sonrakine esne.
  if (enIyi < budget * 0.5) {
    const tasan = sinirlar.find((konum) => konum > budget);
    const ustSinir = budget * (1 + overflowRatio);
    if (tasan && tasan <= ustSinir) {
      return temiz.slice(0, tasan).trim();
    }
  }

  if (enIyi === 0) {
    const kesme = temiz.lastIndexOf(' ', budget);
    return `${temiz.slice(0, kesme > 0 ? kesme : budget).trim()}…`;
  }

  return temiz.slice(0, enIyi).trim();
};

/**
 * Model ciktisinin yarida kesilip kesilmedigini anlar.
 *
 * Saglayicilar bunu `finish_reason: 'length'` ile bildirir ama her zaman
 * guvenilir degildir; metnin kendisi de kontrol edilir. Yarim kalan bir
 * ciktiyi yayina vermek, okuyucuya cumlenin ortasinda biten haber
 * gostermek demektir.
 */
export const looksTruncated = (text: string, finishReason?: string | null): boolean => {
  if (finishReason === 'length') return true;

  const temiz = text.trim();
  if (!temiz) return false;

  // Duzgun biten metin noktalama ile biter.
  return !/[.!?…"'»)\]]$/.test(temiz);
};
