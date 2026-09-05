import { helpSections, type HelpSection } from '../../src/help/content';
import type { Dialect, MachineTemplate } from '../../src/types';

/** Slide-over reference panel — codes, kinematics and machine notes. */
export class HelpPanel {
  private dialect: Dialect = 'fanuc';
  private template: MachineTemplate | undefined;
  private active = 'start';

  constructor(private readonly host: HTMLElement) {
    host.className = 'help-modal';
    host.hidden = true;
    host.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t === host || t.dataset.act === 'close') this.hide();
      const nav = t.closest('[data-section]') as HTMLElement | null;
      if (nav) {
        this.active = nav.dataset.section!;
        this.render();
      }
    });
  }

  setContext(dialect: Dialect, template: MachineTemplate | undefined): void {
    this.dialect = dialect;
    this.template = template;
    if (!this.host.hidden) this.render();
  }

  toggle(): void {
    if (this.host.hidden) this.show();
    else this.hide();
  }

  show(): void {
    this.host.hidden = false;
    this.render();
  }

  hide(): void {
    this.host.hidden = true;
  }

  private render(): void {
    const sections = helpSections(this.dialect, this.template);
    if (!sections.some((s) => s.id === this.active)) this.active = sections[0].id;
    const current = sections.find((s) => s.id === this.active)!;

    this.host.innerHTML = `
      <div class="help-card" role="dialog" aria-label="Help & reference">
        <header>
          <h2>Help &amp; reference<span class="help-dialect">${dialectLabel(this.dialect)}</span></h2>
          <button class="ghost" data-act="close">✕</button>
        </header>
        <div class="help-body">
          <nav class="help-nav">
            ${sections
              .map(
                (s) =>
                  `<button class="${s.id === this.active ? 'active' : ''}" data-section="${s.id}">${s.title}</button>`
              )
              .join('')}
          </nav>
          <article class="help-content">
            ${renderSection(current)}
          </article>
        </div>
      </div>`;
  }
}

function dialectLabel(d: Dialect): string {
  return d === 'citizen' ? 'Citizen Cincom' : d === 'mitsubishi' ? 'Mitsubishi' : 'Fanuc';
}

function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
}

function renderSection(s: HelpSection): string {
  const paras = s.body
    .map((b) =>
      /^\s{2,}/.test(b) || b.startsWith('  ')
        ? `<pre class="help-pre">${esc(b.replace(/^\s+/, ''))}</pre>`
        : `<p>${esc(b)}</p>`
    )
    .join('');
  const codes = s.codes
    ? `<table class="help-codes"><tbody>${s.codes
        .map((c) => `<tr><td class="hc">${esc(c.code)}</td><td>${esc(c.desc)}</td></tr>`)
        .join('')}</tbody></table>`
    : '';
  return `<h3>${esc(s.title)}</h3>${paras}${codes}`;
}
