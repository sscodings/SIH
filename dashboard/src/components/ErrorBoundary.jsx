import React from 'react';

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('[ErrorBoundary caught error]:', error, errorInfo);
    this.setState({ errorInfo });
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          padding: '24px',
          margin: '20px auto',
          maxWidth: '800px',
          backgroundColor: 'rgba(30, 41, 59, 0.95)',
          border: '1px solid #ef4444',
          borderRadius: '8px',
          color: '#f8fafc',
          fontFamily: 'var(--font-mono, monospace)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
            <span style={{ fontSize: '24px' }}>⚠️</span>
            <h2 style={{ fontSize: '16px', fontWeight: 700, color: '#ef4444', margin: 0 }}>
              {this.props.title || 'Screen Render Failure Protected by ErrorBoundary'}
            </h2>
          </div>
          <p style={{ fontSize: '13px', color: '#cbd5e1', marginBottom: '16px' }}>
            An unexpected error occurred while rendering this screen. The rest of the mission control application remains safe and operational.
          </p>
          <div style={{
            backgroundColor: '#0f172a',
            padding: '12px',
            borderRadius: '4px',
            fontSize: '11px',
            color: '#fca5a5',
            overflowX: 'auto',
            marginBottom: '16px'
          }}>
            {this.state.error?.toString()}
          </div>
          <button
            type="button"
            onClick={this.handleReset}
            style={{
              padding: '8px 16px',
              backgroundColor: '#ef4444',
              color: '#ffffff',
              border: 'none',
              borderRadius: '4px',
              fontWeight: 700,
              cursor: 'pointer'
            }}
          >
            Reload Screen
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
