export const MEMBER_FILE_LIMIT = 950_000;
export const FILE_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf', 'text/plain', 'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/webm', 'audio/wav', 'video/mp4', 'video/webm']);
export const FILE_ACCEPT = '.jpg,.jpeg,.png,.webp,.gif,.pdf,.txt,.mp3,.m4a,.ogg,.wav,.mp4,.webm';
const extensions = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', pdf: 'application/pdf', txt: 'text/plain', mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav', mp4: 'video/mp4', webm: 'video/webm' };

export function fileSize(bytes) {
  return bytes < 1_000_000 ? `${Math.ceil(bytes / 1_000)} KB` : `${(bytes / 1_000_000).toLocaleString('es-ES', { maximumFractionDigits: 1 })} MB`;
}

export function validateFile(file, limit = MEMBER_FILE_LIMIT) {
  if (!file || !Number.isSafeInteger(file.size) || file.size <= 0) throw new Error('fc_empty_file');
  if (file.size > limit) throw new Error(`fc_file_too_large:${fileSize(limit)}`);
  const mime = file.type || extensions[String(file.name).split('.').pop().toLowerCase()];
  if (!FILE_TYPES.includes(mime)) throw new Error('fc_file_type');
  return mime;
}

export async function uploadReserved({ file, purpose = 'attachment', limit = MEMBER_FILE_LIMIT, client, rpc, check = () => {} }) {
  const mime = validateFile(file, limit);
  check();
  const reservation = await rpc('fc_reserve_file', { p_purpose: purpose, p_name: file.name, p_mime: mime, p_size: file.size });
  check();
  try {
    const bytes = await file.arrayBuffer(); check();
    const { error } = await client.storage.from(reservation.bucket_id).upload(reservation.object_path, bytes, { contentType: mime, cacheControl: '0', upsert: false });
    check(); if (error) throw error;
    const ready = await rpc('fc_finish_file', { p_id: reservation.id }); check(); return ready;
  } catch (error) {
    // A new session must never perform cleanup on behalf of the previous actor.
    if (error?.code !== 'FC_SESSION_CHANGED') {
      try { await removeReserved({ file: reservation, client, rpc, check }); } catch { /* Retained in the owner's cleanup list for retry. */ }
    }
    throw error;
  }
}

export async function removeReserved({ file, client, rpc, check = () => {} }) {
  check();
  await rpc('fc_remove_file', { p_id: file.id }); check();
  const { error } = await client.storage.from(file.bucket_id).remove([file.object_path]);
  check(); if (error) throw error;
}

export async function downloadPrivate({ file, client, check = () => {} }) {
  check();
  const { data, error } = await client.storage.from(file.bucket_id).download(file.object_path);
  check(); if (error) throw error;
  return data;
}
