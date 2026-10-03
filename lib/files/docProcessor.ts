import type { Attachment } from "../chat/types";

export interface ProcessResult {
  attachment: Attachment;
  text?: string;
}

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;  // 25 MB
const ALLOWED_IMAGE = /^(image\/(png|jpeg|jpg|webp|gif|bmp))$/i;
const ALLOWED_DOC   = /^(text\/.*|application\/(pdf|json|csv|javascript|typescript|xml|yaml|yml|zip)|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document)$/i;
const ALLOWED_VIDEO = /^video\/.+/;

export function validateAttachment(file: File): Attachment {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(file.name + " is larger than 25 MB");
  }

  let kind: Attachment["kind"] = "other";
  if (ALLOWED_IMAGE.test(file.type))     kind = "image";
  else if (ALLOWED_VIDEO.test(file.type)) kind = "video";
  else if (ALLOWED_DOC.test(file.type))   kind = "document";

  return {
    id: "att_" + Math.random().toString(36).slice(2, 12),
    name: file.name,
    kind,
    mime: file.type,
    size: file.size,
    status: "pending",
  };
}

export function makePreviewUrl(file: File): string {
  return URL.createObjectURL(file);
}

export async function processDocument(file: File, base: Attachment): Promise<ProcessResult> {
  const att = { ...base, status: "processing" as const };

  if (file.type.startsWith("text/")) {
    const text = await file.text();
    return { attachment: { ...att, status: "ready", text } };
  }

  if (file.type === "application/pdf") {
    // pdftotext handles this on the server side (/api/files/extract).
    return { attachment: { ...att, status: "ready", pages: await countPdfPages(file) } };
  }

  if (/zip|wordprocessing/.test(file.type)) {
    // unzip + parse on the server side.
    return { attachment: { ...att, status: "ready" } };
  }

  return { attachment: { ...att, status: "error", error: "Unsupported document type" } };
}

async function countPdfPages(file: File): Promise<number> {
  // Lightweight heuristic: read the /Type /Page count from PDF objects.
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = new TextDecoder("latin1").decode(reader.result as ArrayBuffer);
      const m = text.match(/\/Type\s*\/Page(?!s)/g);
      resolve(m ? m.length : 0);
    };
    reader.readAsArrayBuffer(file.slice(0, 50 * 1024));
  });
}

export async function extractPdfText(file: File): Promise<string> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch("/api/files/extract-pdf", { method: "POST", body: fd });
  if (!res.ok) throw new Error("PDF extraction failed: " + res.status);
  const data = await res.json();
  return data.text as string;
}
