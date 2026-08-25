'use client';

import { useState } from 'react';

import { readAccessToken } from '../../lib/auth/session';

/**
 * Shows the current session's bearer token so it can be copied for testing
 * MCP clients (MCP Inspector, curl) against `/mcp` without digging it out of
 * devtools. Reads `sessionStorage` directly rather than through
 * `useCurrentProfile`: the token isn't part of the profile API response, it's
 * a client-only value.
 */
type CopyStatus = 'idle' | 'copied' | 'error';

export function AccessTokenField() {
  const [copyStatus, setCopyStatus] = useState<CopyStatus>('idle');
  const token = readAccessToken();

  if (!token) {
    return null;
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(token);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('error');
    }
    setTimeout(() => setCopyStatus('idle'), 1500);
  };

  return (
    <div className="grid gap-2 py-5 sm:grid-cols-[11rem_minmax(0,1fr)] sm:items-start">
      <p className="text-sm font-medium text-slate-600">Access token</p>
      <div>
        <div className="flex items-stretch gap-2">
          <output
            aria-label="Access token"
            className="block w-full break-all rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-700"
          >
            {token}
          </output>
          <button
            type="button"
            onClick={() => void handleCopy()}
            className="min-h-11 shrink-0 touch-manipulation rounded-xl border border-slate-200 px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-cyan-300"
          >
            {copyStatus === 'copied' && 'Скопировано'}
            {copyStatus === 'error' && 'Не удалось'}
            {copyStatus === 'idle' && 'Копировать'}
          </button>
        </div>
        <p className="mt-2 text-sm leading-6 text-slate-500">
          Токен текущей сессии — для подключения MCP-клиентов (например, MCP Inspector) к /mcp. Не
          передавайте его посторонним: им можно действовать от вашего имени, пока сессия не истекла.
        </p>
      </div>
    </div>
  );
}
