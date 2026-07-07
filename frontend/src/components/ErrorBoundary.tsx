import React from 'react';

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
}

/**
 * 全局错误边界：捕获 React 渲染阶段的异常，避免整棵组件树卸载后白屏。
 * 显示错误信息 + 重新加载按钮，并在控制台输出详细堆栈。
 */
export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[ErrorBoundary] React render error:', error, errorInfo);
    this.setState({ errorInfo });
  }

  handleReload = () => {
    window.location.reload();
  };

  handleReset = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
  };

  render() {
    if (this.state.hasError) {
      const { error, errorInfo } = this.state;
      const errorMessage = error?.message || 'Unknown error';
      const errorStack = error?.stack || '';
      const componentStack = errorInfo?.componentStack || '';

      return (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          height: '100vh', background: '#1a1a2e', color: '#e0e0e0', gap: 16,
          fontFamily: 'system-ui, sans-serif', padding: 24,
        }}>
          <div style={{ fontSize: 48, marginBottom: 8 }}>⚠️</div>
          <h2 style={{ fontSize: 18, color: '#ef4444', margin: 0 }}>应用渲染异常</h2>
          <p style={{ fontSize: 13, color: '#999', textAlign: 'center', maxWidth: 500, margin: 0 }}>
            AgentWithU 遇到错误，无法显示界面。请尝试重新加载；若问题持续，请查看日志文件。
          </p>

          <details style={{ marginTop: 12, maxWidth: 600, width: '100%' }}>
            <summary style={{ cursor: 'pointer', fontSize: 13, color: '#818cf8', marginBottom: 8 }}>
              错误详情（点击展开）
            </summary>
            <div style={{
              background: 'rgba(0,0,0,0.3)', borderRadius: 8, padding: 12,
              fontSize: 12, fontFamily: 'monospace', color: '#ccc',
              maxHeight: 200, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
            }}>
              <div style={{ color: '#ef4444', fontWeight: 'bold', marginBottom: 4 }}>
                {errorMessage}
              </div>
              {errorStack && <div style={{ marginBottom: 8, color: '#999' }}>{errorStack.split('\n').slice(0, 5).join('\n')}</div>}
              {componentStack && (
                <>
                  <div style={{ color: '#818cf8', marginTop: 8, marginBottom: 4 }}>Component Stack:</div>
                  <div style={{ color: '#777' }}>{componentStack.split('\n').slice(0, 10).join('\n')}</div>
                </>
              )}
            </div>
          </details>

          <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
            <button
              onClick={this.handleReload}
              style={{
                padding: '8px 20px', borderRadius: 6, border: 'none', cursor: 'pointer',
                background: '#818cf8', color: '#fff', fontSize: 13, fontWeight: 500,
              }}
            >
              🔄 重新加载
            </button>
            <button
              onClick={this.handleReset}
              style={{
                padding: '8px 20px', borderRadius: 6, cursor: 'pointer',
                background: 'rgba(255,255,255,0.1)', color: '#ccc', fontSize: 13,
                border: '1px solid rgba(255,255,255,0.2)',
              }}
            >
              重试渲染
            </button>
          </div>

          <p style={{ fontSize: 11, color: '#666', marginTop: 12 }}>
            日志路径: %APPDATA%\AgentWithU\logs\backend.log
          </p>
        </div>
      );
    }

    return this.props.children;
  }
}
