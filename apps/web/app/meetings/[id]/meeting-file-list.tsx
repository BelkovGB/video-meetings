import type { MeetingFile } from '../../../lib/api/contracts';
import { FileIcon } from './meeting-file-list-icons';
import { MeetingFileRow } from './meeting-file-row';

type MeetingFileListProps = {
  files: MeetingFile[];
  canDelete: boolean;
  downloadingId: string | null;
  deletingId: string | null;
  deleteCandidateId: string | null;
  onDownload: (file: MeetingFile) => void;
  onRequestDelete: (file: MeetingFile) => void;
  onCancelDelete: () => void;
  onConfirmDelete: (file: MeetingFile) => void;
};

export function MeetingFileList({
  files,
  canDelete,
  downloadingId,
  deletingId,
  deleteCandidateId,
  onDownload,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
}: MeetingFileListProps) {
  if (files.length === 0) {
    return (
      <div className="mt-6 rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-5 py-12 text-center">
        <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-cyan-100 text-cyan-800">
          <FileIcon />
        </span>
        <h3 className="mt-4 text-lg font-semibold">У встречи пока нет файлов</h3>
        <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-600">
          Когда появятся записи или документы, они будут доступны здесь участникам встречи.
        </p>
      </div>
    );
  }

  return (
    <ul className="mt-6 space-y-3">
      {files.map((file) => (
        <MeetingFileRow
          key={file.id}
          file={file}
          canDelete={canDelete}
          isDownloading={downloadingId === file.id}
          isDeleting={deletingId === file.id}
          isConfirmingDelete={deleteCandidateId === file.id}
          onDownload={onDownload}
          onRequestDelete={onRequestDelete}
          onCancelDelete={onCancelDelete}
          onConfirmDelete={onConfirmDelete}
        />
      ))}
    </ul>
  );
}
