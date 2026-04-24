/**
 * Copies text to the clipboard, falling back to document.execCommand for
 * insecure (HTTP) contexts where navigator.clipboard is unavailable.
 * @param {string} text
 * @returns {Promise<void>}
 */
export async function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }

  // Fallback for HTTP contexts
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand("copy");
  } finally {
    document.body.removeChild(textarea);
  }
}
