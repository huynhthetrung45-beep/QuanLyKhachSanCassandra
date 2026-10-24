// API cua cac chuc nang moi (PT-01..PT-26). Dung chung co che cookie phien voi api.js.
import { ApiError } from '../api';

const BASE = import.meta.env.VITE_API_BASE || '/api/v1';

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Không kết nối được máy chủ ChatOTT.');
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    const e = data?.error || {};
    const err = new ApiError(res.status, e.code || 'HTTP_' + res.status, e.message || 'Yêu cầu không thành công.', e.fields);
    signal(err);
    throw err;
  }
  return data;
}

// Bao cho App biet phien can 2FA / xac minh email / het han.
export function signal(err) {
  if (err.code === 'TWO_FACTOR_REQUIRED' || err.code === 'EMAIL_NOT_VERIFIED') {
    window.dispatchEvent(new CustomEvent('chatott:gate', { detail: { code: err.code } }));
  } else if (err.status === 401) {
    window.dispatchEvent(new CustomEvent('chatott:unauthorized', { detail: err }));
  }
}

// Tai body nhi phan (anh, ghi am). headers: them header tuy chon.
export async function uploadRaw(path, blob, headers = {}) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method: 'POST', credentials: 'same-origin', body: blob,
      headers: { 'Content-Type': 'application/octet-stream', ...headers }
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Mất kết nối khi tải lên.');
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    const e = data?.error || {};
    const err = new ApiError(res.status, e.code || 'HTTP_' + res.status,
      e.message || (res.status === 413 ? 'Tệp quá lớn.' : 'Tải lên không thành công.'));
    signal(err);
    throw err;
  }
  return data;
}

const enc = encodeURIComponent;

export const ext = {
  // tai khoan
  forgotPassword: email => request('POST', '/auth/password/forgot', { email }),
  resetPassword: (token, newPassword, confirmPassword) => request('POST', '/auth/password/reset', { token, newPassword, confirmPassword }),
  verifyTwoFactor: code => request('POST', '/auth/2fa/verify', { code }),
  security: () => request('GET', '/me/security'),
  changePassword: payload => request('POST', '/me/password', payload),
  changeDisplayName: displayName => request('PATCH', '/me/display-name', { displayName }),
  sessions: () => request('GET', '/me/sessions'),
  revokeSession: id => request('DELETE', `/me/sessions/${id}`),
  revokeOtherSessions: () => request('DELETE', '/me/sessions'),
  sendVerification: () => request('POST', '/me/email/verification'),
  verifyEmail: code => request('POST', '/me/email/verify', { code }),
  setup2fa: () => request('POST', '/me/2fa/setup'),
  enable2fa: code => request('POST', '/me/2fa/enable', { code }),
  disable2fa: code => request('POST', '/me/2fa/disable', { code }),
  uploadAvatar: blob => uploadRaw('/me/avatar', blob),
  uploadCover: blob => uploadRaw('/me/cover', blob),
  removeAvatar: () => request('DELETE', '/me/avatar'),
  removeCover: () => request('DELETE', '/me/cover'),
  avatars: ids => request('GET', `/avatars?ids=${enc(ids.join(','))}`),
  suggestions: () => request('GET', '/friends/suggestions'),

  // nhom
  roles: id => request('GET', `/conversations/${id}/roles`),
  setRole: (id, userId, role) => request('PUT', `/conversations/${id}/members/${enc(userId)}/role`, { role }),
  claimOwner: id => request('POST', `/conversations/${id}/claim-owner`),
  groupProfile: id => request('GET', `/conversations/${id}/profile`),
  updateGroupProfile: (id, description) => request('PATCH', `/conversations/${id}/profile`, { description }),
  uploadGroupAvatar: (id, blob) => uploadRaw(`/conversations/${id}/avatar`, blob),
  removeGroupAvatar: id => request('DELETE', `/conversations/${id}/avatar`),
  setPrefs: (id, payload) => request('PUT', `/conversations/${id}/prefs`, payload),
  prefs: () => request('GET', '/me/conversation-prefs'),
  invites: id => request('GET', `/conversations/${id}/invites`),
  createInvite: (id, requireApproval) => request('POST', `/conversations/${id}/invites`, { requireApproval }),
  revokeInvite: (id, code) => request('DELETE', `/conversations/${id}/invites/${enc(code)}`),
  decideJoin: (id, userId, approve) => request('POST', `/conversations/${id}/join-requests/${enc(userId)}/${approve ? 'approve' : 'decline'}`),
  previewInvite: code => request('GET', `/invites/${enc(code)}`),
  joinInvite: code => request('POST', `/invites/${enc(code)}/join`),

  // tin nhan
  stickers: () => request('GET', '/stickers'),
  editMessage: (id, m, content) => request('PATCH', `/conversations/${id}/messages/${m.messageId}`, { createdAt: m.createdAt, content }),
  editHistory: (id, messageId) => request('GET', `/conversations/${id}/messages/${messageId}/edits`),
  sendSticker: (id, stickerId) => request('POST', `/conversations/${id}/stickers`, { stickerId }),
  createPoll: (id, payload) => request('POST', `/conversations/${id}/polls`, payload),
  poll: (id, pollId) => request('GET', `/conversations/${id}/polls/${pollId}`),
  vote: (id, pollId, choices) => request('PUT', `/conversations/${id}/polls/${pollId}/vote`, { choices }),
  closePoll: (id, pollId) => request('POST', `/conversations/${id}/polls/${pollId}/close`),
  sendVoice: (id, blob, durationMs) => uploadRaw(`/conversations/${id}/voice`, blob, { 'X-Duration-Ms': String(Math.round(durationMs)) }),
  mentions: () => request('GET', '/me/mentions'),
  suggestReplies: id => request('POST', `/conversations/${id}/ai/reply-suggestions`),
  translate: (id, m, targetLang) => request('POST', `/conversations/${id}/messages/${m.messageId}/translate`, { createdAt: m.createdAt, targetLang }),

  // bai viet
  savePost: postId => request('PUT', `/posts/${postId}/save`),
  unsavePost: postId => request('DELETE', `/posts/${postId}/save`),
  savedPosts: cursor => request('GET', `/me/saved-posts${cursor ? '?cursor=' + enc(cursor) : ''}`),
  hashtagPosts: (tag, cursor) => request('GET', `/hashtags/${enc(tag)}/posts${cursor ? '?cursor=' + enc(cursor) : ''}`),
  stories: () => request('GET', '/stories'),
  createStory: (content, background) => request('POST', '/stories', { content, background }),
  createImageStory: (blob, content, background) => uploadRaw('/stories/media', blob, { 'X-Story-Text': enc(content || ''), 'X-Story-Background': enc(background || '') }),
  viewStory: (authorId, storyId) => request('POST', `/stories/${enc(authorId)}/${storyId}/view`),
  storyViewers: storyId => request('GET', `/stories/mine/${storyId}/viewers`),
  deleteStory: storyId => request('DELETE', `/stories/mine/${storyId}`),

  // thong bao
  notificationSettings: () => request('GET', '/me/notification-settings'),
  updateNotificationSettings: types => request('PUT', '/me/notification-settings', { types }),
  pushStatus: () => request('GET', '/push/status'),
  subscribePush: sub => request('POST', '/push/subscriptions', sub),
  unsubscribePush: endpoint => request('DELETE', '/push/subscriptions', { endpoint }),

  // bao cao & quan tri
  report: payload => request('POST', '/reports', payload),
  adminOverview: () => request('GET', '/admin/overview'),
  adminReports: status => request('GET', `/admin/reports?status=${status}`),
  resolveReport: (id, action, note) => request('POST', `/admin/reports/${id}/resolve`, { action, note }),
  hideContent: payload => request('POST', '/admin/content/hide', payload),
  restoreContent: payload => request('POST', '/admin/content/restore', payload),
  adminUsers: q => request('GET', `/admin/users?q=${enc(q || '')}`),
  lockUser: (userId, reason) => request('POST', `/admin/users/${enc(userId)}/lock`, { reason }),
  unlockUser: userId => request('POST', `/admin/users/${enc(userId)}/unlock`),
  setUserRole: (userId, role) => request('POST', `/admin/users/${enc(userId)}/role`, { role }),
  moderationLog: () => request('GET', '/admin/moderation-log'),
  runReminders: () => request('POST', '/admin/reminders/run')
};

export const REPORT_REASONS = [
  ['SPAM', 'Spam / quảng cáo'], ['HARASSMENT', 'Quấy rối, bắt nạt'], ['HATE', 'Ngôn từ thù ghét'], ['NUDITY', 'Nội dung khiêu dâm'],
  ['VIOLENCE', 'Bạo lực'], ['SCAM', 'Lừa đảo'], ['FAKE', 'Giả mạo'], ['OTHER', 'Khác']
];
