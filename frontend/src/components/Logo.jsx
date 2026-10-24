export default function Logo({ size = 40 }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="16" fill="#16324F" />
      <path d="M14 22a8 8 0 0 1 8-8h20a8 8 0 0 1 8 8v12a8 8 0 0 1-8 8H30l-9 7v-7h1a8 8 0 0 1-8-8z" fill="#14A39A" />
      <rect x="22" y="22" width="20" height="3.6" rx="1.8" fill="#fff" />
      <rect x="22" y="29" width="13" height="3.6" rx="1.8" fill="#fff" opacity=".75" />
    </svg>
  );
}
