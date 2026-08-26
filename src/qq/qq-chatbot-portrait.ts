export interface QqChatbotPortraitResult {
  content: string;
  portraitFile?: string;
}

function isSafeImageFileName(value: string): boolean {
  return !value.includes("/") && !value.includes("\\") && !value.includes("\0") && /\.(?:png|jpe?g|gif|webp|avif)$/i.test(value);
}

export function extractQqChatbotPortrait(content: string, portraitFiles: string[] | undefined): QqChatbotPortraitResult {
  const match = /^【立绘\s*[:：]\s*([^】]+)】\r?\n?/.exec(content);
  if (!match) return { content };

  const fileName = match[1]!.trim();
  const nextContent = content.slice(match[0].length);
  if (!isSafeImageFileName(fileName)) return { content: nextContent };
  if (!portraitFiles?.includes(fileName)) return { content: nextContent };
  return { content: nextContent, portraitFile: fileName };
}
