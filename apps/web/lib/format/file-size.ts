const units = ['Б', 'КБ', 'МБ', 'ГБ'];

/** Formats a byte count for display, e.g. `1,5 МБ`. */
export function formatFileSize(sizeBytes: number): string {
  let value = sizeBytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(value)} ${units[unitIndex]}`;
}
