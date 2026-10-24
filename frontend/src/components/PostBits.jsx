import { Globe, Lock, Users } from 'lucide-react';

export const PRIVACY_INFO = {
  PUBLIC: { label: 'Công khai', icon: Globe },
  FRIENDS: { label: 'Bạn bè', icon: Users },
  PRIVATE: { label: 'Chỉ mình tôi', icon: Lock }
};

export const POST_REACTIONS = [
  { key: 'LIKE', emoji: '👍', label: 'Thích' },
  { key: 'LOVE', emoji: '❤️', label: 'Yêu thích' },
  { key: 'HAHA', emoji: '😂', label: 'Haha' },
  { key: 'WOW', emoji: '😮', label: 'Wow' },
  { key: 'SAD', emoji: '😢', label: 'Buồn' },
  { key: 'ANGRY', emoji: '😡', label: 'Phẫn nộ' }
];
export const reactionOf = key => POST_REACTIONS.find(r => r.key === key);

export function PrivacyIcon({ value, size = 13 }) {
  const info = PRIVACY_INFO[value] || PRIVACY_INFO.FRIENDS;
  const Icon = info.icon;
  return <Icon size={size} aria-label={info.label} />;
}

export function PrivacySelect({ value, onChange, id }) {
  return (
    <label className="privacy-select" title="Ai có thể xem">
      <PrivacyIcon value={value} size={14} />
      <select id={id} value={value} onChange={e => onChange(e.target.value)} aria-label="Quyền riêng tư">
        {Object.entries(PRIVACY_INFO).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
      </select>
    </label>
  );
}
