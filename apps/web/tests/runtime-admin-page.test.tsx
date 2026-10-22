import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { RuntimeErrorBoundary } from '@/components/runtime-admin-page';

describe('RuntimeAdminPage error boundary', () => {
  it('rethrows Next redirect control flow instead of rendering its digest', () => {
    const redirect = Object.assign(new Error('NEXT_REDIRECT'), {
      digest: 'NEXT_REDIRECT;replace;/admin/plugin/zjmf-upstream/connections;303;',
    });
    const boundary = new RuntimeErrorBoundary({ children: createElement('div') });
    boundary.state = RuntimeErrorBoundary.getDerivedStateFromError(redirect);

    expect(() => boundary.render()).toThrow(redirect);
  });

  it('still renders ordinary plugin rendering errors', () => {
    const boundary = new RuntimeErrorBoundary({ children: createElement('div') });
    boundary.state = RuntimeErrorBoundary.getDerivedStateFromError(new Error('组件加载失败'));

    const rendered = boundary.render();
    expect(rendered.props.children).toBe('组件加载失败');
  });
});
