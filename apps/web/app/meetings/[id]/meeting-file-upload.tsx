'use client';

import type { MeetingFile } from '../../../lib/api/contracts';
import { FileDropzone } from './file-dropzone';
import { UploadProgress } from './upload-progress';
import { useMeetingFileUpload } from './use-meeting-file-upload';

type MeetingFileUploadProps = {
  meetingId: string;
  onUploaded: (file: MeetingFile) => void;
  onError: (message: string) => void;
  onStart: () => void;
};

export function MeetingFileUpload({
  meetingId,
  onUploaded,
  onError,
  onStart,
}: MeetingFileUploadProps) {
  const { upload, isBusy, uploadSelection, cancelUpload } = useMeetingFileUpload({
    meetingId,
    onUploaded,
    onError,
    onStart,
  });

  return (
    <section
      aria-labelledby="meeting-upload-title"
      className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="meeting-upload-title" className="text-lg font-semibold text-slate-950">
            Загрузка файла
          </h3>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            Аудио, видео, транскрипты, PDF и DOCX — до 1 ГБ.
          </p>
        </div>
        <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-600 shadow-sm ring-1 ring-slate-200">
          По одному файлу
        </span>
      </div>

      <FileDropzone isBusy={isBusy} onFilesSelected={uploadSelection} />

      {upload ? <UploadProgress upload={upload} onCancel={cancelUpload} /> : null}
    </section>
  );
}
