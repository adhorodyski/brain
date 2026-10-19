/** Telegram's own ceiling; a longer answer arrives as several messages rather than being lost. */
export function chunks(text: string, size = 4096): string[] {
  if (text.length <= size) return [text];
  const parts: string[] = [];
  for (let start = 0; start < text.length; start += size) parts.push(text.slice(start, start + size));
  return parts;
}

export async function send(env: Env, chatId: string, text: string): Promise<void> {
  for (const part of chunks(text)) {
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: part, disable_web_page_preview: true }),
    });
    if (!response.ok) console.error(`telegram send failed (${response.status}) for ${chatId}`);
  }
}
