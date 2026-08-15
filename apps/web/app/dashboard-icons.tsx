export function CameraIcon() {
  return (
    <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24">
      <path
        d="M4 7.8A1.8 1.8 0 0 1 5.8 6h7.4A1.8 1.8 0 0 1 15 7.8v8.4a1.8 1.8 0 0 1-1.8 1.8H5.8A1.8 1.8 0 0 1 4 16.2V7.8Z"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="m15 10.1 4.2-2.3c.8-.4 1.8.1 1.8 1v6.4c0 .9-1 1.4-1.8 1L15 13.9v-3.8Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function CalendarIcon() {
  return (
    <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24">
      <rect x="4" y="5" width="16" height="15" rx="2" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M8 3v4M16 3v4M4 10h16"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24">
      <path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
    </svg>
  );
}
