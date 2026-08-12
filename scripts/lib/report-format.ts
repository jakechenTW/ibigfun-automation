const GOOGLE_MAP_COORDINATE_LINK = /\[地圖\]\(https:\/\/www\.google\.com\/maps\?q=-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?\)/;

/** Validate the user-facing Markdown body before it is handed to ai-notify. */
export function validateNotificationReport(report: string): void {
  const lines = report.split(/\r?\n/);
  const firstContentLine = lines.find((line) => line.trim().length > 0)?.trim();
  if (!firstContentLine) throw new Error('report body must not be empty');
  if (/^#{1,6}\s/.test(firstContentLine)) {
    throw new Error('report body must start with the conclusion; --title owns the notification title');
  }

  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!/^(?:-\s+)?🚶/.test(trimmed) || trimmed.replace(/^-\s+/, '') === '🚶 無位置資訊') continue;
    if (!GOOGLE_MAP_COORDINATE_LINK.test(trimmed)) {
      throw new Error(`walking line ${index + 1} must include a clickable Google Maps coordinate link`);
    }
    if (!trimmed.includes('ORS') || !trimmed.includes('Valhalla') || !trimmed.includes('（試行）')) {
      throw new Error(`walking line ${index + 1} must include ORS and Valhalla trial labels`);
    }
  }
}
