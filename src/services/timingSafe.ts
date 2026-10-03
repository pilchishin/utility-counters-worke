/**
 * Сравнение двух строк за постоянное время.
 *
 * Обычное сравнение строк (`a === b`) завершается на первом же
 * несовпадающем символе, из-за чего ответ на "почти верное" значение
 * в теории приходит чуть медленнее, чем на "совсем неверное" — по
 * этой разнице во времени можно подбирать секрет посимвольно.
 * Используется везде, где сравнивается секрет, пришедший от внешнего
 * вызывающего (заголовок webhook, пароль администратора, токен
 * ручного запуска).
 */
export function timingSafeStringEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);

  if (aBytes.byteLength !== bBytes.byteLength) {
    return false;
  }
  return crypto.subtle.timingSafeEqual(aBytes, bBytes);
}