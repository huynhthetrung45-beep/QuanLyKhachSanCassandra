import { Component } from 'react';

// Chan loi render cua mot phan giao dien de khong lam trang toan bo ung dung.
// Khong xoa phien hay du lieu: chi cho phep thu lai hoac tai lai trang.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[ChatOTT] Lỗi giao diện:', error, info?.componentStack);
  }

  componentDidUpdate(prev) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="chat-state" role="alert">
        <p className="error-text">{this.props.message || 'Phần giao diện này gặp lỗi và không hiển thị được.'}</p>
        <p className="muted">{String(this.state.error.message || this.state.error).slice(0, 200)}</p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn secondary small" onClick={() => this.setState({ error: null })}>Thử lại</button>
          <button type="button" className="btn primary small" onClick={() => window.location.reload()}>Tải lại trang</button>
        </div>
      </div>
    );
  }
}
