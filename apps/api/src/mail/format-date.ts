import type { Locale } from 'i18n';
import { JST_OFFSET_MS } from 'shared';

/** メール本文用の日付（JST）。日本語は「2027年3月31日」、英語は「March 31, 2027」。 */
export const jstDate = (locale: Locale, d: Date): string => {
  const j = new Date(d.getTime() + JST_OFFSET_MS);
  const [y, m, day] = [j.getUTCFullYear(), j.getUTCMonth() + 1, j.getUTCDate()];
  return locale === 'ja' ? `${y}年${m}月${day}日` : `${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][m - 1]} ${day}, ${y}`;
};
