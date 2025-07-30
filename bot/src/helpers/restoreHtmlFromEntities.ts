import { MessageEntity } from 'telegraf/types'

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function restoreHtmlFromEntities(text: string, entities: MessageEntity[]): string {
  if (!entities || entities.length === 0) return escapeHtml(text)

  const openTags: Record<number, string[]> = {}
  const closeTags: Record<number, string[]> = {}

  for (const entity of entities) {
    const { offset, length, type } = entity
    const end = offset + length

    let tagOpen = ''
    let tagClose = ''

    switch (type) {
      case 'bold':
        tagOpen = '<b>'
        tagClose = '</b>'
        break
      case 'italic':
        tagOpen = '<i>'
        tagClose = '</i>'
        break
      case 'underline':
        tagOpen = '<u>'
        tagClose = '</u>'
        break
      case 'strikethrough':
        tagOpen = '<s>'
        tagClose = '</s>'
        break
      case 'spoiler':
        tagOpen = '<span class="tg-spoiler">'
        tagClose = '</span>'
        break
      case 'code':
        tagOpen = '<code>'
        tagClose = '</code>'
        break
      case 'pre':
        tagOpen = '<pre>'
        tagClose = '</pre>'
        break
      case 'blockquote':
        tagOpen = '<blockquote>'
        tagClose = '</blockquote>'
        break
      case 'text_link':
        tagOpen = `<a href="${entity.url}">`
        tagClose = '</a>'
        break
      case 'text_mention':
        tagOpen = `<a href="tg://user?id=${entity.user.id}">`
        tagClose = '</a>'
        break
      default:
        continue
    }

    if (!openTags[offset]) openTags[offset] = []
    if (!closeTags[end]) closeTags[end] = []

    openTags[offset].push(tagOpen)
    closeTags[end].unshift(tagClose) // закрывающие — в обратном порядке
  }

  let result = ''
  for (let i = 0; i <= text.length; i++) {
    if (closeTags[i]) result += closeTags[i].join('')
    if (openTags[i]) result += openTags[i].join('')
    if (i < text.length) result += escapeHtml(text[i])
  }

  return result
}
