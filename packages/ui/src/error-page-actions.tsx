'use client';

import { Button } from './button.js';

export function ErrorPageActions() {
  return (
    <>
      <Button
        size="lg"
        variant="outline"
        onClick={() => {
          if (window.history.length > 1) window.history.back();
          else window.location.assign('/');
        }}
      >
        返回上一页
      </Button>
      <Button size="lg" render={<a href="/" />}>
        返回首页
      </Button>
    </>
  );
}
