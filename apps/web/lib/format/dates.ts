/**
 * Date formatters for meeting screens.
 *
 * The dashboard and the meeting page render meeting dates differently: the
 * dashboard lists upcoming meetings and omits the year, the meeting page is a
 * detail view and shows it. They used to share the name `formatMeetingDate` in
 * two files with different options, which made the difference invisible. Two
 * explicit names keep it visible; unifying them is a UI decision, not a
 * refactor.
 */

/** `15 августа, 10:30` — dashboard meeting list. */
export function formatMeetingDateShort(date: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(date));
}

/** `15 августа 2026 г., 10:30` — meeting detail header. */
export function formatMeetingDateWithYear(date: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(date));
}

/** `15 авг. 2026 г.` — file upload timestamps. */
export function formatUploadDate(date: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(date));
}
