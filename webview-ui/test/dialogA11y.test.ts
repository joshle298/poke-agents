/**
 * Dialog, checkbox and tab semantics the pickers (and every other modal)
 * rely on: the markup assistive tech reads (react-dom/server, no DOM), and
 * the pure keyboard and focus rules.
 *
 * Run with: npm test
 */

import type { FunctionComponent, ReactNode } from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';

import { isTextEntry } from '../src/components/ui/focusRules.js';
import { tabButtonId, tabKeyTarget, tabPanelId } from '../src/components/ui/tabKeys.js';

/** The components' props. The test tsconfig has no JSX or DOM lib, so the
 *  .tsx modules are imported untyped and described here. */
interface CheckboxProps {
  checked: boolean;
  onChange: () => void;
  label: ReactNode;
}
interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
}
interface TabListProps {
  label: string;
  idPrefix: string;
  tabs: ReadonlyArray<{ id: string; label: ReactNode }>;
  selected: string;
  onSelect: (id: string) => void;
}

const CHECKBOX_MODULE = '../src/components/ui/Checkbox.js';
const MODAL_MODULE = '../src/components/ui/Modal.js';
const TABLIST_MODULE = '../src/components/ui/TabList.js';
let Checkbox: FunctionComponent<CheckboxProps>;
let Modal: FunctionComponent<ModalProps>;
let TabList: FunctionComponent<TabListProps>;

beforeAll(async () => {
  ({ Checkbox } = (await import(/* @vite-ignore */ CHECKBOX_MODULE)) as {
    Checkbox: FunctionComponent<CheckboxProps>;
  });
  ({ Modal } = (await import(/* @vite-ignore */ MODAL_MODULE)) as {
    Modal: FunctionComponent<ModalProps>;
  });
  ({ TabList } = (await import(/* @vite-ignore */ TABLIST_MODULE)) as {
    TabList: FunctionComponent<TabListProps>;
  });
});

const noop = () => {};

describe('Checkbox', () => {
  it('is a checkbox that states whether it is checked', () => {
    const on = renderToStaticMarkup(
      createElement(Checkbox, { checked: true, onChange: noop, label: 'Shiny' }),
    );
    expect(on).toContain('role="checkbox"');
    expect(on).toContain('aria-checked="true"');
    expect(on).toContain('type="button"');
    const off = renderToStaticMarkup(
      createElement(Checkbox, { checked: false, onChange: noop, label: 'Fast mode' }),
    );
    expect(off).toContain('aria-checked="false"');
  });
});

describe('Modal', () => {
  it('is a modal dialog named by its title', () => {
    const html = renderToStaticMarkup(
      createElement(Modal, {
        isOpen: true,
        onClose: noop,
        title: 'Switch model',
        children: createElement('p', null, 'Body'),
      }),
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    const labelledBy = /aria-labelledby="([^"]+)"/.exec(html)?.[1];
    expect(labelledBy).toBeTruthy();
    expect(html).toContain(`id="${labelledBy}"`);
    expect(html).toMatch(new RegExp(`id="${labelledBy}"[^>]*>Switch model<`));
    // The panel itself can take focus (when its first control is a text field).
    expect(html).toContain('tabindex="-1"');
  });

  it('renders nothing while closed', () => {
    expect(
      renderToStaticMarkup(
        createElement(Modal, { isOpen: false, onClose: noop, title: 'x', children: null }),
      ),
    ).toBe('');
  });
});

describe('TabList', () => {
  it('follows the tab pattern: selected state, the panel it controls, one Tab stop', () => {
    const html = renderToStaticMarkup(
      createElement(TabList, {
        label: 'Agent',
        idPrefix: 'model-picker',
        tabs: [
          { id: 'claude', label: 'Claude' },
          { id: 'codex', label: 'Codex' },
        ],
        selected: 'codex',
        onSelect: noop,
      }),
    );
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-label="Agent"');
    const tabs = [...html.matchAll(/<button[^>]*>/g)].map((m) => m[0]);
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toContain(`id="${tabButtonId('model-picker', 'claude')}"`);
    expect(tabs[0]).toContain('aria-selected="false"');
    expect(tabs[0]).toContain('tabindex="-1"');
    expect(tabs[1]).toContain('aria-selected="true"');
    expect(tabs[1]).toContain('tabindex="0"');
    for (const tab of tabs) {
      expect(tab).toContain('role="tab"');
      expect(tab).toContain(`aria-controls="${tabPanelId('model-picker')}"`);
    }
  });

  it('moves with the arrow keys (wrapping), Home and End', () => {
    expect(tabKeyTarget('ArrowRight', 0, 3)).toBe(1);
    expect(tabKeyTarget('ArrowRight', 2, 3)).toBe(0);
    expect(tabKeyTarget('ArrowLeft', 0, 3)).toBe(2);
    expect(tabKeyTarget('Home', 2, 3)).toBe(0);
    expect(tabKeyTarget('End', 0, 3)).toBe(2);
    expect(tabKeyTarget('Enter', 0, 3)).toBeNull();
    expect(tabKeyTarget('ArrowRight', 0, 0)).toBeNull();
    // No tab selected yet: as if on the first.
    expect(tabKeyTarget('ArrowRight', -1, 3)).toBe(1);
  });
});

describe('dialog focus', () => {
  it('knows which controls take typed text (focusing one summons a phone keyboard)', () => {
    expect(isTextEntry('TEXTAREA', null)).toBe(true);
    expect(isTextEntry('input', null)).toBe(true);
    expect(isTextEntry('INPUT', 'search')).toBe(true);
    expect(isTextEntry('INPUT', 'checkbox')).toBe(false);
    expect(isTextEntry('BUTTON', null)).toBe(false);
    expect(isTextEntry('SELECT', null)).toBe(false);
    expect(isTextEntry('DIV', null, true)).toBe(true);
  });
});
