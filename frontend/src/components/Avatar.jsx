import { Users } from 'lucide-react';
import { avatarColor, initials } from '../utils';
import { useAvatarSrc } from '../extensions/avatarStore';

export default function Avatar({ name, seed, group = false, size = 44, online = false }) {
  const src = useAvatarSrc(seed); // PT-04 / PT-10: anh dai dien that neu da dat
  const style = {
    width: size,
    height: size,
    fontSize: Math.round(size * 0.36),
    background: avatarColor(seed || name)
  };
  return (
    <span className="avatar" style={style} aria-hidden="true">
      {src ? <img className="avatar-img" src={src} alt="" loading="lazy" /> : group ? <Users size={Math.round(size * 0.46)} /> : initials(name)}
      {online && <span className="avatar-dot" />}
    </span>
  );
}
