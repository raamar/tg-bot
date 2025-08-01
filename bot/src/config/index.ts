import { ActionMessage, FunnelMessage, SendActionType } from '../types/funnel'

export const happyEnd = {
  text: ['✅ Оплата прошла! ✅\n\n', 'Спасибо за доверие! Получи доступ к гайду по ссылке ниже.\n\n'].join(''),
  button_text: '👉 Получить гайд 👈',
  url: 'https://t.me/+lLncxyeRls5lZTMy',
}

export const actionsMessages: Record<Exclude<SendActionType, 'BUY_LINK' | 'DEFAULT'>, ActionMessage> = {
  START: {
    photoUrl: 'https://storage.yandexcloud.net/leadconverter/messenger/HZPGGVY9NiKHfqLNZJwbYreiEt1sYR4x55dia0vY.png',
    text: [
      '<b>Привет!</b> Дай угадаю, ты и не думала, что твои ножки могут оплатить тебе отпуск?\n\n',
      'Тогда с гордостью представляю тебе:\n\n',
      '<b>ГАЙД: Как я заработала миллион на фото своих ног🦶💸</b>\n\n',
      'И ты будешь удивлена, когда узнаешь, что футфетиш — <b>это самый популярный фетиш в мире!</b>\n\n',
      '<i>По статистике говорится, что до <b>1 из 7 мужчин</b> проявляют явный интерес к стопам, а по данным PornHub ',
      '«foot fetish» стабильно входит в <b>ТОП всех мировых запросов.</b></i>\n\n',
      '<b>Так что, ДА, на этом можно ОХРЕНИТЕЛЬНО заработать!</b> Сейчас вообще можно сказать, что идёт тренд на такой вид ',
      'заработка.\n\n',
      '<b>Просто посмотрите на Американский TikTok:</b> он буквально завален видео, где девушки показывают свои роскошные ',
      'покупки <i>(дома, машины, сумки и т.д.)</i>, просто продавая фото своих ног 🤯\n\n',
      'В России этот тренд только набирает популярность и это при том, что модели славянской внешности — <b>самые ',
      'востребованные по всему миру!</b> Так что нам с вами в какой-то степени повезло и будет намного легче работать...\n\n',
      '<b>А самое крутое — это то, что можно работать НЕ показывая лица и БЕЗ откровенного контента</b> 🔞🔥',
    ].join(''),
    buttons: [{ text: '👉 Что будет внутри Гайда? 👈', action: 'CONTENTS' }],
  },
  CONTENTS: {
    text: [
      '<b>Что тебя ждёт внутри Гайда:</b>\n\n',
      '<b>ℹ️ ВВОДНАЯ ИНФОРМАЦИЯ</b>\n',
      ' • Мой путь к миллиону на фото ног\n',
      ' • Что вообще такое ФУТФЕТИШ\n',
      ' • Почему мужчины сходят с ума по ногам\n',
      ' • Почему хотят купить именно у тебя\n',
      ' • Почему твои ноги точно подойдут\n',
      ' • Нужно ли быть популярной или красивой\n',
      ' • Как работать без интима и лица\n',
      ' • Как работать без знания английского\n',
      ' • РФ vs Зарубеж: сколько реально платят\n\n',
      '<b>📸 ПЕРЕХОДИМ К ДЕЛУ</b>\n',
      ' • Какой образ выбрать\n',
      ' • Какие фото будут покупать\n',
      ' • Секреты контента: золотые триггеры\n',
      ' • Как и где начать зарабатывать\n',
      ' • Лучшие сайты для работы\n',
      ' • Как продвигать себя\n',
      ' • Примеры контента и профилей\n',
      ' • Как общаться с мужчинами\n\n',
      '<b>💸 ОПЛАТА</b>\n',
      ' • Куда получать деньги\n',
      ' • Инструкция по крипте для новичков\n\n',
      '<b>🤫 ДОПОЛНИТЕЛЬНО</b>\n',
      ' • Легально ли это? Налоги?\n',
      ' • Как оставаться анонимной\n',
      ' • Как совмещать с обычной работой\n',
      ' • Как заработать больше (доп. фетиши)\n\n',
      '<i>Даже если ты совсем не шаришь в фотках, не знаешь английского и впервые слышишь слово «фетиш» — ',
      'не переживай! Я всё объяснила простым языком, пошагово, как подруге — так что ты точно разберёшься!</i>',
    ].join(''),
    buttons: [{ text: '👉 Хочу гайд! 👈', action: 'START_FUNNEL' }],
  },
  START_FUNNEL: {
    text: [
      '<blockquote><u>😱И всё это всего за 990₽😱</u></blockquote>\n\n',
      '<b>⚠️Важно⚠️</b>\n',
      'Доступ к гайду придёт не на почту, а в этот Телеграм-бот!\n\n',
      '<i>И да, ты покупаешь не просто гайд — ты покупаешь пожизненный доступ ко всем обновлениям ',
      'и секретам, которые я буду узнавать, без всяких доплат!</i>',
    ].join(''),
    buttons: [{ text: '👉 Купить за 990₽ 👈', action: 'BUY_LINK', amount: 990.0 }],
  },
  SUBSCRIBE: {
    text: '⚠️Скидка действует только сегодня⚠️',
    buttons: [{ text: '👉 Купить за 490₽ 👈', action: 'BUY_LINK', amount: 490.0 }],
  },
}

export const funnelMessages: FunnelMessage[] = [
  {
    id: 'reminder1',
    delayMs: 1000 * 60 * 60 * 2, // 2 часа
    text: [
      'Привет — это Rina Bloom 👋\n\n',
      'Вижу, ты ещё не купил/а <b>Гайд: Как я заработала миллион на фото своих ног🦶💸</b>\n\n',
      'Возможно, у тебя появились проблемы с оплатой или остались какие-либо дополнительные вопросы?\n\n',
      'Тогда можешь написать мне сюда, я отвечу тебе лично:\n',
      '@bloom_helper\n\n',
      '<b>⚠️Важно⚠️</b>\n',
      'Доступ к гайду придёт не на почту, а в этот Телеграм-бот!',
    ].join(''),
    buttons: [{ text: '👉 Купить за 990₽ 👈', action: 'BUY_LINK', amount: 990.0 }],
  },
  {
    id: 'reminder2',
    delayMs: 1000 * 60 * 60 * 22, // 22 часа
    photoUrl: 'https://storage.yandexcloud.net/leadconverter/messenger/E8TkfA2Q3pR5dcc8OgWYATdIfaaPevraM9ETvIga.png',
    text: [
      'Мои ученицы уже делают первые результаты — <b>а ты всё ещё сомневаешься?</b> 🤪\n\n',
      '<b>⚠️Важно⚠️</b>\n',
      'Доступ к гайду придёт не на почту, а в этот Телеграм-бот!',
    ].join(''),
    buttons: [{ text: '👉 Купить за 990₽ 👈', amount: 990.0, action: 'BUY_LINK' }],
  },
  {
    id: 'reminder3',
    delayMs: 1000 * 60 * 60 * 24, // 24 часа
    text: [
      'Солнышко, это снова я — Rina Bloom ☀️\n\n',
      'Хочу предупредить — после последнего обновления гайда: <b>я решила поднять цену!</b>\n\n',
      'Почему? Да потому что всё чаще получаю сообщения вроде: ',
      '<i>«Он стоит гораздо больше!»</i> — <b>и, знаешь, я начала с этим соглашаться.</b>\n\n',
      '<blockquote>Но! Для тех, кто давно присматривался — оставляю старую цену ещё на 24 часа.\n',
      'Потом всё, цена станет выше. Лови момент 💋</blockquote>\n\n',
      '⚠️<b>Через 24 часа станет дороже</b>⚠️',
    ].join(''),
    buttons: [{ text: '👉 Купить за 990₽ 👈', amount: 990.0, action: 'BUY_LINK' }],
  },
  {
    id: 'reminder4',
    delayMs: 1000 * 60 * 60 * 24, // 24 часа
    stop: true,
    text: [
      '🥳 У меня сегодня День Рождение — <b>а подарки будут для вас!</b> 😱\n\n',
      '<b>СКИДКА -50%</b> на Гайд: Как я заработала миллион на фото своих ног🦶💸\n\n',
      '<i>Так что, если ты давно хотела, но никак не решалась: <b>Действуй! ',
      'Лучшего момента, чем сегодня, не будет уже никогда!</b></i>\n\n',
      '<b>Для того что бы получить скидку</b> - нужно просто подписаться на мою страницу Вконтакте\n',
      "<a href='https://vk.com/club231146128'>👉ПОДПИСАТЬСЯ👈</a>\n\n",
      '<b>⚠️Скидка действует только сегодня⚠️</b>',
    ].join(''),
    buttons: [{ text: '✅ Подписалась ✅', action: 'SUBSCRIBE' }],
  },
]

export const defaultExpirationMessage = 'Вы уже открыли этот раздел ✅'
export const default403Message = '👉 Для начала введите /start'
export const default500Message = 'Произошла ошибка. Попробуйте еще раз позже.'
