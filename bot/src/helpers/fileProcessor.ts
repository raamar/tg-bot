import axios from 'axios'
import { Telegraf } from 'telegraf'

export async function processContactsFile(bot: Telegraf, fileId: string): Promise<string[]> {
  try {
    const file = await bot.telegram.getFile(fileId)

    // Дополнительная проверка расширения
    if (!file.file_path?.endsWith('.txt')) {
      throw new Error('Invalid file extension')
    }

    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${file.file_path}`

    // Ограничение времени загрузки
    const response = await axios.get(fileUrl, {
      timeout: 10000, // 10 секунд
      maxContentLength: 1024 * 1024, // 1MB
      responseType: 'text',
    })

    // Проверка содержимого
    if (typeof response.data !== 'string') {
      throw new Error('Invalid file content')
    }

    const text = response.data

    // Парсинг контактов с валидацией
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => {
        // Проверяем что строка содержит только цифры (для telegram ID)
        return line.length > 0 && /^\d+$/.test(line)
      })
  } catch (error) {
    console.error('Ошибка при обработке файла:', error)
    return []
  }
}
