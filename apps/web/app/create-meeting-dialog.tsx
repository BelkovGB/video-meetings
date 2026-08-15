'use client';

import {
  Alert,
  AlertContent,
  AlertIndicator,
  AlertTitle,
  Button,
  Input,
  Label,
  Spinner,
  TextField,
} from '@heroui/react';
import { useRouter } from 'next/navigation';
import { FormEvent, useRef, useState } from 'react';
import { apiUrl } from '../lib/api/config';
import type { ApiError, Meeting } from '../lib/api/contracts';
import { readAccessToken } from '../lib/auth/session';
import { CloseIcon } from './dashboard-icons';

type FormErrors = {
  title?: string;
  date?: string;
};

type CreateMeetingDialogProps = {
  isOpen: boolean;
  /**
   * Counts the requests to open the form. The dashboard keeps its "create
   * meeting" buttons visible while the form is open, and pressing one of them
   * again clears the errors the form currently shows.
   */
  openRequestCount: number;
  onCreated: (meeting: Meeting) => void;
  onClose: () => void;
};

const meetingDateMin = '2000-01-01T00:00';
const meetingDateMax = '2100-12-31T23:59';

function getMeetingDateError(value: string): string | undefined {
  if (!value) {
    return 'Укажите дату и время встречи.';
  }

  const [yearPart] = value.split('-');
  const year = Number(yearPart);

  if (!/^\d{4}$/.test(yearPart) || year < 2000 || year > 2100) {
    return 'Укажите год с 2000 по 2100.';
  }

  if (Number.isNaN(new Date(value).getTime())) {
    return 'Введите корректные дату и время.';
  }

  return undefined;
}

function getApiErrorMessage(error: ApiError) {
  if (Array.isArray(error.message)) {
    return 'Проверьте название и дату встречи.';
  }

  return error.message ?? 'Не удалось выполнить запрос. Попробуйте ещё раз.';
}

export function CreateMeetingDialog({
  isOpen,
  openRequestCount,
  onCreated,
  onClose,
}: CreateMeetingDialogProps) {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [date, setDate] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FormErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [clearedOpenRequestCount, setClearedOpenRequestCount] = useState(openRequestCount);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const dateInputRef = useRef<HTMLInputElement>(null);

  // The form keeps what was typed while it stays mounted, so only the reported
  // errors are dropped when the dashboard asks to open it again.
  if (clearedOpenRequestCount !== openRequestCount) {
    setClearedOpenRequestCount(openRequestCount);
    setSubmitError(null);
    setFieldErrors({});
  }

  const validateTitle = () => {
    setFieldErrors((currentErrors) => ({
      ...currentErrors,
      title: title.trim() ? undefined : 'Введите название встречи.',
    }));
  };

  const validateDate = () => {
    setFieldErrors((currentErrors) => ({
      ...currentErrors,
      date: getMeetingDateError(date),
    }));
  };

  const validateMeetingForm = (): boolean => {
    const nextFieldErrors: FormErrors = {
      title: title.trim() ? undefined : 'Введите название встречи.',
      date: getMeetingDateError(date),
    };

    if (!nextFieldErrors.title && !nextFieldErrors.date) {
      return true;
    }

    setFieldErrors(nextFieldErrors);
    requestAnimationFrame(() => {
      if (nextFieldErrors.title) {
        titleInputRef.current?.focus();
        return;
      }

      dateInputRef.current?.focus();
    });
    return false;
  };

  const createMeeting = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const token = readAccessToken();

    if (!token) {
      router.replace('/login');
      return;
    }

    if (!validateMeetingForm()) {
      return;
    }

    setSubmitError(null);
    setIsCreating(true);

    try {
      const response = await fetch(`${apiUrl}/meetings`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title: title.trim(), date: new Date(date).toISOString() }),
      });
      const data = (await response.json()) as Omit<Meeting, 'accessRole'> & ApiError;

      if (!response.ok || !data.id) {
        setSubmitError(getApiErrorMessage(data));
        return;
      }

      onCreated({ ...data, accessRole: 'owner' });
      setTitle('');
      setDate('');
      onClose();
    } catch {
      setSubmitError('Не удалось создать встречу. Проверьте соединение и повторите попытку.');
    } finally {
      setIsCreating(false);
    }
  };

  const formErrorMessages = [
    fieldErrors.title ? `Название: ${fieldErrors.title}` : null,
    fieldErrors.date ? `Дата и время: ${fieldErrors.date}` : null,
    submitError,
  ].filter((message): message is string => Boolean(message));

  if (!isOpen) {
    return null;
  }

  return (
    <section
      aria-labelledby="create-meeting-title"
      className="mb-8 rounded-3xl border border-cyan-200/20 bg-white p-6 text-slate-950 shadow-xl sm:p-8"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id="create-meeting-title" className="text-xl font-semibold">
            Новая встреча
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Заполните детали — встреча появится в списке сразу после создания.
          </p>
        </div>
        <button
          type="button"
          className="grid h-11 w-11 place-items-center rounded-xl text-slate-600 transition hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-cyan-500"
          aria-label="Закрыть форму создания встречи"
          onClick={() => {
            onClose();
            setSubmitError(null);
            setFieldErrors({});
          }}
        >
          <CloseIcon />
        </button>
      </div>
      <form
        className="mt-6 grid gap-4 sm:grid-cols-[1fr_220px_auto] sm:items-end"
        noValidate
        onSubmit={createMeeting}
      >
        <TextField
          isInvalid={Boolean(fieldErrors.title)}
          isRequired
          fullWidth
          value={title}
          onChange={(value) => {
            setTitle(value);
            setSubmitError(null);
            if (fieldErrors.title) {
              setFieldErrors((currentErrors) => ({ ...currentErrors, title: undefined }));
            }
          }}
        >
          <Label className="mb-2 text-sm font-medium text-slate-700">Название</Label>
          <Input
            ref={titleInputRef}
            autoComplete="off"
            placeholder="Например, планирование спринта"
            aria-describedby={fieldErrors.title ? 'create-meeting-errors' : undefined}
            onBlur={validateTitle}
            className="h-12 rounded-xl border border-slate-200 bg-slate-50 px-4 text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-cyan-500 focus:bg-white focus:ring-4 focus:ring-cyan-100"
          />
        </TextField>
        <TextField
          isInvalid={Boolean(fieldErrors.date)}
          isRequired
          fullWidth
          value={date}
          onChange={(value) => {
            setDate(value);
            setSubmitError(null);
            if (fieldErrors.date) {
              setFieldErrors((currentErrors) => ({
                ...currentErrors,
                date: getMeetingDateError(value),
              }));
            }
          }}
          type="datetime-local"
        >
          <Label className="mb-2 text-sm font-medium text-slate-700">Дата и время</Label>
          <Input
            ref={dateInputRef}
            min={meetingDateMin}
            max={meetingDateMax}
            aria-describedby={fieldErrors.date ? 'create-meeting-errors' : undefined}
            onBlur={validateDate}
            className="h-12 rounded-xl border border-slate-200 bg-slate-50 px-4 text-slate-950 outline-none transition focus:border-cyan-500 focus:bg-white focus:ring-4 focus:ring-cyan-100"
          />
        </TextField>
        <Button
          type="submit"
          isDisabled={isCreating}
          className="h-12 rounded-xl bg-slate-950 px-5 text-sm font-semibold text-white hover:bg-slate-800"
        >
          {isCreating ? <Spinner size="sm" color="current" /> : 'Создать'}
        </Button>
      </form>
      {formErrorMessages.length > 0 ? (
        <Alert
          id="create-meeting-errors"
          role="alert"
          status="danger"
          className="mt-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-red-950"
        >
          <AlertIndicator className="text-red-700" />
          <AlertContent>
            <AlertTitle className="text-sm font-semibold text-red-900">
              {submitError && !fieldErrors.title && !fieldErrors.date
                ? 'Не удалось создать встречу'
                : 'Проверьте данные встречи'}
            </AlertTitle>
            <div className="text-sm font-medium text-red-800">
              <ul className="list-disc space-y-1 pl-5">
                {formErrorMessages.map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            </div>
          </AlertContent>
        </Alert>
      ) : null}
    </section>
  );
}
