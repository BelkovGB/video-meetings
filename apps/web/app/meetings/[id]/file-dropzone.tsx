'use client';

import { ChangeEvent, DragEvent, useState } from 'react';

import { acceptValue } from './use-meeting-file-upload';

type FileDropzoneProps = {
  isBusy: boolean;
  onFilesSelected: (files: FileList | null) => void;
};

export function FileDropzone({ isBusy, onFilesSelected }: FileDropzoneProps) {
  const [isDragging, setIsDragging] = useState(false);

  const handleInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    onFilesSelected(event.target.files);
    event.target.value = '';
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    onFilesSelected(event.dataTransfer.files);
  };

  return (
    <div
      data-testid="upload-dropzone"
      onDragEnter={(event) => {
        event.preventDefault();
        if (!isBusy) {
          setIsDragging(true);
        }
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = isBusy ? 'none' : 'copy';
      }}
      onDragLeave={(event) => {
        const relatedTarget = event.relatedTarget;
        if (!(relatedTarget instanceof Node) || !event.currentTarget.contains(relatedTarget)) {
          setIsDragging(false);
        }
      }}
      onDrop={handleDrop}
      className={`mt-4 rounded-2xl border-2 border-dashed px-5 py-7 text-center outline-none transition duration-200 focus:ring-2 focus:ring-cyan-600 focus:ring-offset-2 sm:py-9 ${
        isDragging
          ? 'border-cyan-500 bg-cyan-50'
          : 'border-slate-300 bg-white hover:border-cyan-400 hover:bg-cyan-50/40'
      } ${isBusy ? 'cursor-wait opacity-70' : ''}`}
    >
      <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-cyan-100 text-cyan-800">
        <UploadIcon />
      </span>
      <p className="mt-4 font-semibold text-slate-950">Перетащите файл сюда</p>
      <p className="mt-1 text-sm text-slate-600">или выберите его на устройстве</p>
      <label
        className={`mt-4 inline-flex min-h-11 touch-manipulation items-center justify-center rounded-xl bg-slate-950 px-5 text-sm font-semibold text-white transition focus-within:ring-2 focus-within:ring-cyan-600 focus-within:ring-offset-2 ${
          isBusy ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-slate-800'
        }`}
      >
        Выбрать файл
        <input
          type="file"
          accept={acceptValue}
          disabled={isBusy}
          aria-label="Выбрать файл"
          className="sr-only"
          onChange={handleInputChange}
        />
      </label>
    </div>
  );
}

function UploadIcon() {
  return (
    <svg aria-hidden="true" className="h-6 w-6" fill="none" viewBox="0 0 24 24">
      <path
        d="M12 16V5m0 0L8 9m4-4 4 4M5 15v4h14v-4"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}
