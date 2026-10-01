import type { AppConfig } from "./config.ts";
import { ApiError, configurationError } from "./errors.ts";

interface TranscriptionResponse {
  text?: unknown;
  language?: unknown;
  languages?: unknown;
}

export interface TranscriptionResult {
  text: string;
  language: string;
}

function extensionForMime(mimeType: string): string {
  switch (mimeType) {
    case "audio/webm":
      return "webm";
    case "audio/mpeg":
      return "mp3";
    case "audio/mp4":
      return "m4a";
    case "audio/wav":
    case "audio/x-wav":
      return "wav";
    default:
      throw new ApiError(415, "UNSUPPORTED_AUDIO_MIME", "Formato de áudio não suportado.");
  }
}

export function assertTranscriptionConfigured(config: AppConfig): void {
  if (!config.openAiApiKey) throw configurationError("OPENAI_API_KEY");
}

export async function transcribeAudio(
  blob: Blob,
  mimeType: string,
  language: string,
  config: AppConfig,
): Promise<TranscriptionResult> {
  assertTranscriptionConfigured(config);
  const extension = extensionForMime(mimeType);
  const form = new FormData();
  form.append(
    "file",
    new File([blob], `qa-audio.${extension}`, { type: mimeType }),
  );
  form.append("model", config.openAiTranscribeModel);
  form.append("language", language);
  form.append("response_format", "json");
  if (config.openAiTranscribePrompt) {
    form.append("prompt", config.openAiTranscribePrompt.slice(0, 1_000));
  }

  let response: Response;
  try {
    response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.openAiApiKey}`,
      },
      body: form,
      signal: AbortSignal.timeout(config.transcriptionTimeoutMs),
    });
  } catch (error) {
    throw new ApiError(
      503,
      error instanceof DOMException && error.name === "TimeoutError"
        ? "TRANSCRIPTION_TIMEOUT"
        : "TRANSCRIPTION_NETWORK_ERROR",
      "Serviço de transcrição temporariamente indisponível.",
      true,
      { cause: error },
    );
  }

  if (!response.ok) {
    const retryable = response.status === 408 || response.status === 409 ||
      response.status === 429 || response.status >= 500;
    const code = response.status === 429
      ? "TRANSCRIPTION_RATE_LIMITED"
      : response.status >= 500
      ? "TRANSCRIPTION_PROVIDER_UNAVAILABLE"
      : "TRANSCRIPTION_REJECTED";
    throw new ApiError(
      retryable ? 503 : 422,
      code,
      retryable
        ? "Serviço de transcrição temporariamente indisponível."
        : "O áudio não pôde ser transcrito.",
      retryable,
    );
  }

  let payload: TranscriptionResponse;
  try {
    payload = await response.json() as TranscriptionResponse;
  } catch (error) {
    throw new ApiError(
      503,
      "INVALID_TRANSCRIPTION_RESPONSE",
      "Resposta inválida do serviço de transcrição.",
      true,
      { cause: error },
    );
  }
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  if (!text) {
    throw new ApiError(
      422,
      "EMPTY_TRANSCRIPTION",
      "Nenhuma fala foi identificada no áudio.",
    );
  }

  let detectedLanguage = language;
  if (typeof payload.language === "string" && payload.language.trim()) {
    detectedLanguage = payload.language.trim().toLowerCase();
  } else if (Array.isArray(payload.languages)) {
    const first = payload.languages.find((entry) =>
      entry && typeof entry === "object" && typeof entry.code === "string"
    );
    if (first && typeof first === "object" && typeof first.code === "string") {
      detectedLanguage = first.code.toLowerCase();
    }
  }

  return { text, language: detectedLanguage };
}
