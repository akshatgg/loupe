// A friendly "on its way" panel for features still being built.

import { h, icon } from '../ui.js';

export function placeholderPanel({ id, title, iconName, heading, body }) {
  return {
    id, title, icon: iconName,
    mount(container) {
      container.append(h('div', { class: 'panel-empty' },
        h('div', { class: 'empty-icon' }, icon(iconName, { size: 28 })),
        h('h3', {}, heading),
        h('p', {}, body)));
      return { update() {} };
    }
  };
}
