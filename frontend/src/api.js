// Lop goi API duy nhat. Cookie phien (HttpOnly) duoc trinh duyet tu gui kem;
// JavaScript khong doc va khong luu token o dau ca.
const BASE = import.meta.env.VITE_API_BASE || '/api/v1';

export class ApiError extends Error {
  constructor(status, code, message, fields) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields || null;
  }
}

async function request(method, path, { body, signal, query } = {}) {
  const qs = query
    ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null)).toString()
    : '';
  let res;
  try {
    res = await fetch(BASE + path + qs, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK_ERROR', 'Không kết nối được máy chủ ChatOTT. Kiểm tra backend đang chạy ở cổng 3000.');
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    const error = data?.error || {};
    const apiError = new ApiError(
      res.status,
      error.code || 'HTTP_' + res.status,
      error.message || 'Yêu cầu không thành công.',
      error.fields
    );
    // Chuc nang moi: phien can ma 2FA / xac minh email -> App hien man hinh tuong ung.
    if (res.status === 403 && ['TWO_FACTOR_REQUIRED', 'EMAIL_NOT_VERIFIED'].includes(apiError.code)) {
      window.dispatchEvent(new CustomEvent('chatott:gate', { detail: { code: apiError.code } }));
    }
    if (res.status === 401 && !path.startsWith('/auth/login')) {
      window.dispatchEvent(new CustomEvent('chatott:unauthorized', { detail: apiError }));
    }
    throw apiError;
  }
  return data;
}

// Chuan hoa tin nhan: backend cu (chua migration 002) khong tra cac truong moi.
// Thieu truong thi dung gia tri rong, khong de giao dien loi vi undefined.
export function normalizeMessage(m) {
  if (!m || typeof m !== 'object') return m;
  return {
    ...m,
    reactions: Array.isArray(m.reactions) ? m.reactions : [],
    attachments: Array.isArray(m.attachments) ? m.attachments : [],
    replyTo: m.replyTo || null,
    sharedPostId: m.sharedPostId || null,
    forwarded: Boolean(m.forwarded)
  };
}

const withMessages = page => ({ ...page, items: (page?.items || []).map(normalizeMessage) });

export const api = {
  me: () => request('GET', '/auth/me'),
  login: (email, password) => request('POST', '/auth/login', { body: { email, password } }),
  register: payload => request('POST', '/auth/register', { body: payload }),
  logout: () => request('POST', '/auth/logout'),

  conversations: () => request('GET', '/me/conversations'),
  conversation: id => request('GET', `/conversations/${id}`),
  messages: (id, { pageToken, signal } = {}) =>
    request('GET', `/conversations/${id}/messages`, { query: { limit: 20, pageToken }, signal }).then(withMessages),
  // Cua so lich su quanh / truoc / sau mot tin: cursor = "<createdAt>_<messageId>"
  messageWindow: (id, { around, before, after, signal } = {}) =>
    request('GET', `/conversations/${id}/messages`, { query: { limit: 20, around, before, after }, signal }).then(withMessages),
  pins: (id, signal) => request('GET', `/conversations/${id}/pins`, { signal }),
  pinMessage: (id, m) => request('PUT', `/conversations/${id}/messages/${m.messageId}/pin`, { body: { createdAt: m.createdAt } }),
  unpinMessage: (id, messageId) => request('DELETE', `/conversations/${id}/messages/${messageId}/pin`),
  send: (id, content) => request('POST', `/conversations/${id}/messages`, { body: { content } }),
  // payload: { content?, replyTo?: { messageId, createdAt }, attachmentIds?: [] }
  sendMessage: (id, payload) => request('POST', `/conversations/${id}/messages`, { body: payload }).then(normalizeMessage),
  forward: (targetId, source) => request('POST', `/conversations/${targetId}/forward`, { body: { source } }),
  react: (id, message, emoji) =>
    request('PUT', `/conversations/${id}/messages/${message.messageId}/reaction`, { body: { emoji, createdAt: message.createdAt } }),
  unreact: (id, message) =>
    request('DELETE', `/conversations/${id}/messages/${message.messageId}/reaction`, { query: { createdAt: message.createdAt } }),
  hide: (id, message) =>
    request('POST', `/conversations/${id}/messages/${message.messageId}/hide`, { body: { createdAt: message.createdAt } }),
  typing: id => request('POST', `/conversations/${id}/typing`),
  attachments: (id, kind, pageToken) => request('GET', `/conversations/${id}/attachments`, { query: { kind, pageToken } }),
  cancelAttachment: (id, attachmentId) => request('DELETE', `/conversations/${id}/attachments/${attachmentId}`),
  recall: (id, message) =>
    request('DELETE', `/conversations/${id}/messages/${message.messageId}`, { query: { createdAt: message.createdAt } }),
  stats: id => request('GET', `/conversations/${id}/stats`),
  markRead: id => request('POST', `/conversations/${id}/read`),
  pin: (id, pinned) => request('PUT', `/conversations/${id}/pin`, { body: { pinned } }),

  myProfile: () => request('GET', '/me/profile'),
  updateProfile: payload => request('PATCH', '/me/profile', { body: payload }),
  profile: userId => request('GET', `/users/${encodeURIComponent(userId)}/profile`),
  friends: () => request('GET', '/friends'),
  friendRequests: direction => request('GET', '/friends/requests', { query: { direction } }),
  sendFriendRequest: targetUserId => request('POST', '/friends/requests', { body: { targetUserId } }),
  cancelFriendRequest: userId => request('DELETE', `/friends/requests/${encodeURIComponent(userId)}`),
  acceptFriend: userId => request('POST', `/friends/requests/${encodeURIComponent(userId)}/accept`),
  declineFriend: userId => request('POST', `/friends/requests/${encodeURIComponent(userId)}/decline`),
  unfriend: userId => request('DELETE', `/friends/${encodeURIComponent(userId)}`),
  blocks: () => request('GET', '/blocks'),
  block: targetUserId => request('POST', '/blocks', { body: { targetUserId } }),
  unblock: userId => request('DELETE', `/blocks/${encodeURIComponent(userId)}`),

  feed: cursor => request('GET', '/feed', { query: { cursor } }),
  timeline: (userId, cursor) => request('GET', `/users/${encodeURIComponent(userId)}/posts`, { query: { cursor } }),
  post: postId => request('GET', `/posts/${postId}`),
  createPost: payload => request('POST', '/posts', { body: payload }),
  updatePost: (postId, payload) => request('PATCH', `/posts/${postId}`, { body: payload }),
  deletePost: postId => request('DELETE', `/posts/${postId}`),
  sharePost: (postId, payload) => request('POST', `/posts/${postId}/share`, { body: payload }),
  reactPost: (postId, reaction) => request('PUT', `/posts/${postId}/reaction`, { body: { reaction } }),
  unreactPost: postId => request('DELETE', `/posts/${postId}/reaction`),
  comments: (postId, pageToken) => request('GET', `/posts/${postId}/comments`, { query: { pageToken } }),
  addComment: (postId, content) => request('POST', `/posts/${postId}/comments`, { body: { content } }),
  editComment: (postId, commentId, content) => request('PATCH', `/posts/${postId}/comments/${commentId}`, { body: { content } }),
  deleteComment: (postId, commentId) => request('DELETE', `/posts/${postId}/comments/${commentId}`),
  cancelPostMedia: mediaId => request('DELETE', `/posts/media/${mediaId}`),

  notifications: pageToken => request('GET', '/notifications', { query: { pageToken } }),
  unreadNotifications: () => request('GET', '/notifications/unread-count'),
  readNotification: id => request('POST', `/notifications/${id}/read`),
  readAllNotifications: () => request('POST', '/notifications/read-all'),
  searchMessages: (params, signal) => request('GET', '/search/messages', { query: params, signal }),
  conversationAnalytics: (id, days) => request('GET', `/conversations/${id}/analytics`, { query: { days } }),
  myAnalytics: () => request('GET', '/me/analytics'),
  aiOverview: id => request('GET', `/conversations/${id}/ai`),
  aiSummarize: (id, limit) => request('POST', `/conversations/${id}/ai/summaries`, { body: { limit } }),
  aiUpdateTask: (id, taskId, payload) => request('PATCH', `/conversations/${id}/ai/tasks/${taskId}`, { body: payload }),
  addReply: (postId, content, replyToCommentId, clientId) => request('POST', `/posts/${postId}/comments`, { body: { content, replyToCommentId, clientId } }),
  postReactions: (postId, type, pageToken) => request('GET', `/posts/${postId}/reactions`, { query: { type, pageToken } }),
  replies: (postId, rootId, pageToken) => request('GET', `/posts/${postId}/comments/${rootId}/replies`, { query: { pageToken } }),

  searchUsers: (q, signal) => request('GET', '/users/search', { query: { q }, signal }),
  openDirect: targetUserId => request('POST', '/conversations/direct', { body: { targetUserId } }),
  createGroup: (name, memberIds) => request('POST', '/conversations/groups', { body: { name, memberIds } }),
  renameGroup: (id, name) => request('PATCH', `/conversations/${id}`, { body: { name } }),
  addMembers: (id, memberIds) => request('POST', `/conversations/${id}/members`, { body: { memberIds } }),
  removeMember: (id, memberId) => request('DELETE', `/conversations/${id}/members/${encodeURIComponent(memberId)}`)
};

export const EVENTS_URL = BASE + '/events';

// Duong dan tai tep qua API (co kiem tra dang nhap + thanh vien). Khong co duong dan tinh.
export function attachmentUrl(conversationId, attachmentId, inline = false) {
  return `${BASE}/conversations/${conversationId}/attachments/${attachmentId}/content${inline ? '?inline=1' : ''}`;
}

export const postMediaUrl = (postId, mediaId) => `${BASE}/posts/${postId}/media/${mediaId}`;
export const pendingMediaUrl = mediaId => `${BASE}/posts/media/${mediaId}/preview`;

// Tai anh cua bai viet len (cung co che XHR co tien do).
export function uploadPostMedia(file, onProgress) {
  return uploadAttachment(null, file, onProgress, `${BASE}/posts/media`);
}

// Tai tep len bang XHR de co tien do. Tra ve { promise, abort }.
export function uploadAttachment(conversationId, file, onProgress, url) {
  const xhr = new XMLHttpRequest();
  const promise = new Promise((resolve, reject) => {
    xhr.open('POST', url || `${BASE}/conversations/${conversationId}/attachments`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    xhr.upload.onprogress = e => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { data = null; }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
      const error = data?.error || {};
      const apiError = new ApiError(xhr.status, error.code || 'HTTP_' + xhr.status,
        error.message || (xhr.status === 413 ? 'Tệp vượt quá dung lượng cho phép.' : 'Tải tệp lên không thành công.'));
      if (xhr.status === 401) window.dispatchEvent(new CustomEvent('chatott:unauthorized', { detail: apiError }));
      reject(apiError);
    };
    xhr.onerror = () => reject(new ApiError(0, 'NETWORK_ERROR', 'Mất kết nối khi tải tệp lên.'));
    xhr.onabort = () => reject(Object.assign(new Error('Đã hủy'), { name: 'AbortError' }));
    xhr.send(file);
  });
  return { promise, abort: () => xhr.abort() };
}
