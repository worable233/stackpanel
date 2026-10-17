/** Small parser-time runtime: no React or animation-library download required. */
function startHeroRays(canvas: HTMLCanvasElement) {
  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: false });
  if (!canvas || !gl) return;
  const vertex = gl.createShader(gl.VERTEX_SHADER);
  if (!vertex) return;
  gl.shaderSource(
    vertex,
    'attribute vec2 position; void main(){gl_Position=vec4(position,0.,1.);}',
  );
  gl.compileShader(vertex);
  const fragment = gl.createShader(gl.FRAGMENT_SHADER);
  if (!fragment) {
    gl.deleteShader(vertex);
    return;
  }
  gl.shaderSource(
    fragment,
    `precision highp float;
      uniform vec2 resolution, pointer; uniform float time; uniform vec3 tint;
      float field(vec2 delta, vec2 direction, float a, float b, float speed){
        float angle=dot(normalize(delta),direction);
        float bands=clamp(.45+.15*sin(angle*a+time*speed)+.3+.2*cos(-angle*b+time*speed),0.,1.);
        float distance=length(delta);
        return bands*pow(max(angle,0.),2.)*clamp(1.-distance/(resolution.x*3.),0.,1.)*clamp(1.-distance/resolution.x,.5,1.);
      }
      void main(){
        vec2 coord=vec2(gl_FragCoord.x,resolution.y-gl_FragCoord.y);
        vec2 origin=vec2(resolution.x*.5,-resolution.y*.2);
        vec2 direction=normalize(mix(vec2(0.,1.),normalize(pointer*resolution-origin),.1));
        float strength=field(coord-origin,direction,36.2214,21.11349,1.5)*.5+field(coord-origin,direction,22.3991,18.0234,1.1)*.4;
        float fade=1.-coord.y/resolution.y;
        gl_FragColor=vec4(tint*vec3(.1+fade*.8,.3+fade*.6,.5+fade*.5)*strength,strength);
      }`,
  );
  gl.compileShader(fragment);
  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    return;
  }
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    return;
  }
  gl.useProgram(program);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    gl.STATIC_DRAW,
  );
  const attribute = gl.getAttribLocation(program, 'position');
  gl.enableVertexAttribArray(attribute);
  gl.vertexAttribPointer(attribute, 2, gl.FLOAT, false, 0, 0);
  const uniforms = {
    resolution: gl.getUniformLocation(program, 'resolution'),
    pointer: gl.getUniformLocation(program, 'pointer'),
    time: gl.getUniformLocation(program, 'time'),
    tint: gl.getUniformLocation(program, 'tint'),
  };
  const color = getComputedStyle(canvas)
    .getPropertyValue('--clarity-primary')
    .trim()
    .replace('#', '');
  gl.uniform3f(
    uniforms.tint,
    parseInt(color.slice(0, 2), 16) / 255,
    parseInt(color.slice(2, 4), 16) / 255,
    parseInt(color.slice(4, 6), 16) / 255,
  );
  const resize = () => {
    const dpr = Math.min(devicePixelRatio, 1.5);
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(uniforms.resolution, canvas.width, canvas.height);
  };
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();
  let x = 0.5,
    y = 0.5,
    sx = 0.5,
    sy = 0.5,
    frame = 0,
    visible = true;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const pointer = (event: PointerEvent) => {
    if (reduced.matches) return;
    const rect = canvas.getBoundingClientRect();
    x = (event.clientX - rect.left) / rect.width;
    y = (event.clientY - rect.top) / rect.height;
  };
  const render = (time: number) => {
    if (visible) {
      sx = sx * 0.92 + x * 0.08;
      sy = sy * 0.92 + y * 0.08;
      gl.uniform2f(uniforms.pointer, sx, sy);
      gl.uniform1f(uniforms.time, reduced.matches ? 0 : time / 1000);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    frame = requestAnimationFrame(render);
  };
  const visibility = new IntersectionObserver(([entry]) => {
    visible = Boolean(entry?.isIntersecting);
  });
  visibility.observe(canvas);
  window.addEventListener('pointermove', pointer, { passive: true });
  frame = requestAnimationFrame(render);
  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    visibility.disconnect();
    window.removeEventListener('pointermove', pointer);
    gl.deleteBuffer(buffer);
    gl.deleteProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
  };
}

function startClarityMotion(startRays: typeof startHeroRays) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const tracked = new Map<Element, () => void>();
  const reveals = new WeakMap<Element, Animation[]>();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const animations = reveals.get(entry.target);
        if (!animations) continue;
        for (const animation of animations) {
          animation.playbackRate = entry.isIntersecting ? 1 : -1;
          animation.play();
        }
      }
    },
    { threshold: 0.08 },
  );
  const scan = () => {
    for (const element of document.querySelectorAll(
      '[data-reveal], [data-hero-rays], [data-stories]',
    )) {
      if (tracked.has(element)) continue;
      if (element instanceof HTMLCanvasElement) {
        tracked.set(element, startRays(element) ?? (() => {}));
      } else if (element.hasAttribute('data-stories')) {
        let index = 0,
          hovered = false,
          focused = false,
          visible = false;
        const slides = Array.from(element.querySelectorAll<HTMLElement>('[data-story-slide]'));
        const metadata = Array.from(element.querySelectorAll<HTMLElement>('[data-story-meta]'));
        const controls = Array.from(
          element.querySelectorAll<HTMLButtonElement>('[data-story-control]'),
        );
        if (!slides.length || controls.length !== slides.length || metadata.length !== slides.length) continue;
        const effects = new Map<Element, Animation>();
        const select = (next: number) => {
          index = next;
          slides.forEach((slide, i) => {
            for (const target of [slide, metadata[i]]) {
              if (!target) continue;
              const previous = getComputedStyle(target);
              const from = {
                opacity: previous.opacity,
                filter: previous.filter,
                translate: previous.translate,
              };
              effects.get(target)?.cancel();
              const active = i === next;
              effects.set(
                target,
                target.animate(
                  [
                    from,
                    {
                      opacity: active ? 1 : 0,
                      filter: active ? 'blur(0px)' : 'blur(10px)',
                      translate: active ? '0 0' : '0 20px',
                    },
                  ],
                  { duration: reduced.matches ? 0 : 700, fill: 'both', easing: 'ease-out' },
                ),
              );
              target.setAttribute('aria-hidden', String(!active));
            }
            controls[i]?.setAttribute('aria-pressed', String(i === next));
          });
        };
        const onClick = (event: Event) => {
          const button =
            event.target instanceof Element ? event.target.closest('[data-story-control]') : null;
          const next = controls.indexOf(button as HTMLButtonElement);
          if (next >= 0) select(next);
        };
        const enter = () => {
          hovered = true;
        };
        const leave = () => {
          hovered = false;
        };
        const focus = () => {
          focused = true;
        };
        const blur = (event: Event) => {
          if (!element.contains((event as FocusEvent).relatedTarget as Node | null))
            focused = false;
        };
        element.addEventListener('click', onClick);
        element.addEventListener('pointerenter', enter);
        element.addEventListener('pointerleave', leave);
        element.addEventListener('focusin', focus);
        element.addEventListener('focusout', blur);
        const view = new IntersectionObserver(([entry]) => {
          visible = Boolean(entry?.isIntersecting);
        });
        view.observe(element);
        const timer = setInterval(() => {
          if (visible && !hovered && !focused && !reduced.matches)
            select((index + 1) % slides.length);
        }, 7000);
        tracked.set(element, () => {
          clearInterval(timer);
          view.disconnect();
          effects.forEach((animation) => animation.cancel());
          element.removeEventListener('click', onClick);
          element.removeEventListener('pointerenter', enter);
          element.removeEventListener('pointerleave', leave);
          element.removeEventListener('focusin', focus);
          element.removeEventListener('focusout', blur);
        });
      } else {
        const characters = element.querySelectorAll('[data-reveal-character]');
        const targets = characters.length ? Array.from(characters) : [element];
        const animations = reduced.matches
          ? []
          : targets.map((target, index) => {
              const animation = target.animate(
                [
                  { opacity: 0, translate: '0 20px', filter: 'blur(10px)' },
                  { opacity: 1, translate: '0 0', filter: 'blur(0px)' },
                ],
                {
                  duration: 700,
                  delay: Math.min(index, 11) * 40,
                  easing: 'ease-out',
                  fill: 'both',
                },
              );
              animation.pause();
              animation.currentTime = 0;
              return animation;
            });
        reveals.set(element, animations);
        observer.observe(element);
        tracked.set(element, () => {
          observer.unobserve(element);
          animations.forEach((animation) => animation.cancel());
        });
      }
    }
    for (const [element, cleanup] of tracked) {
      if (!element.isConnected) {
        cleanup();
        tracked.delete(element);
      }
    }
  };
  const mutations = new MutationObserver(scan);
  mutations.observe(document.documentElement, { childList: true, subtree: true });
  scan();
  reduced.addEventListener('change', () => {
    for (const element of tracked.keys()) {
      if (reduced.matches) reveals.get(element)?.forEach((animation) => animation.cancel());
    }
  });
  const lights = new WeakMap<Element, Animation[]>();
  document.addEventListener(
    'pointermove',
    (event) => {
      if (event.pointerType === 'touch') return;
      const card =
        event.target instanceof Element ? event.target.closest('[data-spotlight]') : null;
      if (!card) return;
      const bounds = card.getBoundingClientRect();
      const point = `${event.clientX - bounds.left}px ${event.clientY - bounds.top}px`;
      const frames = [
        {
          opacity: 1,
          backgroundImage: `radial-gradient(200px circle at ${point}, var(--clarity-border-highlight), var(--primary), var(--border) 100%)`,
        },
        {
          opacity: 0.8,
          backgroundImage: `radial-gradient(200px circle at ${point}, var(--clarity-hover-surface), transparent 100%)`,
        },
      ];
      const animations = lights.get(card) ?? [];
      Array.from(card.children)
        .slice(0, 2)
        .forEach((element, index) => {
          const frame = frames[index];
          if (!frame) return;
          const animation =
            animations[index] ?? element.animate([frame, frame], { duration: 1, fill: 'both' });
          (animation.effect as KeyframeEffect).setKeyframes([frame, frame]);
          animation.pause();
          animation.currentTime = 0;
          animations[index] = animation;
        });
      lights.set(card, animations);
    },
    { passive: true },
  );
  document.addEventListener(
    'pointerout',
    (event) => {
      const card =
        event.target instanceof Element ? event.target.closest('[data-spotlight]') : null;
      if (!card || (event.relatedTarget instanceof Node && card.contains(event.relatedTarget)))
        return;
      lights.get(card)?.forEach((animation) => animation.cancel());
      lights.delete(card);
    },
    { passive: true },
  );
}

export function getClarityMotionBootstrapScript() {
  return `(${startClarityMotion.toString()})(${startHeroRays.toString()});`;
}
