// Cursor: how the cursor looks, the ripple on clicks, and the keyboard
// shortcut badges. Every control is one undo step; a slider dragged back and
// forth is one step too.

import { slider, toggle, segmented, section } from '../ui.js';
import { setStyle } from '../../../core/project.js';
import { keystrokesSection } from './style-extras.js';

export default {
  id: 'cursor',
  title: 'Cursor',
  icon: 'cursor',
  mount(container, editor) {
    const { store } = editor;
    const edit = (patch, gesture = null) => store.apply((p) => setStyle(p, patch), { gesture });
    const done = () => store.endGesture();
    const style = () => store.project.style;
    const keys = keystrokesSection(editor);

    const showCursor = toggle({ label: 'Show cursor', checked: style().cursor.show, onChange: (v) => { edit({ cursor: { show: v } }); done(); } });
    const size = slider({
      label: 'Cursor size', min: 0.5, max: 3, step: 0.05, value: style().cursor.size,
      format: (v) => `${v.toFixed(1)}×`, onInput: (v) => edit({ cursor: { size: v } }, 'style:cursor-size'), onChange: done
    });
    const smooth = toggle({ label: 'Smooth movement', hint: 'Glides the cursor instead of jittering', checked: style().cursor.smooth, onChange: (v) => { edit({ cursor: { smooth: v } }); done(); } });
    const idle = toggle({ label: 'Hide when still', hint: 'Fades the cursor out when you stop moving it', checked: style().cursor.hideWhenIdle, onChange: (v) => { edit({ cursor: { hideWhenIdle: v } }); done(); } });
    const highlight = segmented({
      label: 'Highlight',
      options: [{ value: 'none', label: 'None' }, { value: 'spotlight', label: 'Spotlight' }, { value: 'ring', label: 'Ring' }],
      value: style().cursor.highlight,
      onChange: (v) => { edit({ cursor: { highlight: v } }); done(); }
    });
    const clicks = toggle({ label: 'Show clicks', hint: 'A ripple wherever you click', checked: style().cursor.clicks, onChange: (v) => { edit({ cursor: { clicks: v } }); done(); } });
    const cursorOnly = [size, smooth, idle, highlight];

    container.append(
      section('Cursor', showCursor, ...cursorOnly),
      section('Clicks', clicks),
      keys.el
    );

    function update() {
      const s = style();
      showCursor.set(s.cursor.show);
      size.set(s.cursor.size);
      smooth.set(s.cursor.smooth);
      idle.set(s.cursor.hideWhenIdle);
      highlight.set(s.cursor.highlight);
      clicks.set(s.cursor.clicks);
      for (const row of cursorOnly) row.classList.toggle('disabled', !s.cursor.show);
      keys.update();
    }
    update();
    return { update };
  }
};
