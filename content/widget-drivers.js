// Stable widget-family layer shared by recruiting sites.
// Site-specific DOM signatures stop here; orchestration sees only families.
(function (root) {
  const normalize = value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const FAMILY_BY_KIND = Object.freeze({
    file: 'file-upload', richtext: 'rich-text', 'custom-select': 'virtual-select',
    'layui-date': 'date-picker', 'native-select': 'native-select', checkbox: 'toggle',
    'moka-date': 'date-picker',
    'custom-checkbox': 'toggle', radio: 'choice', 'custom-radio': 'choice',
    date: 'date-input', combobox: 'autocomplete', overlay: 'overlay-container',
    'option-item': 'overlay-option', 'picker-column': 'picker-column', action: 'action',
    card: 'section-entry', 'section-entry': 'section-entry', input: 'text-input'
  });

  function classify({ kind, role, tagName, editable }) {
    if (FAMILY_BY_KIND[kind]) return FAMILY_BY_KIND[kind];
    if (editable || role === 'textbox') return 'text-input';
    if (role === 'checkbox') return 'toggle';
    if (role === 'radio') return 'choice';
    if (role === 'option' || role === 'menuitem') return 'overlay-option';
    if (role === 'button' || role === 'link') return 'action';
    if (String(tagName || '').toLowerCase() === 'select') return 'native-select';
    return 'unknown';
  }

  function operations({ family, role, readonly, tagName, editable }) {
    if (family === 'file-upload') return ['UPLOAD_FILE'];
    if (family === 'overlay-container') return [];
    if (family === 'date-picker') return ['PICK_DATE'];
    if (family === 'virtual-select' || family === 'section-entry') return ['CLICK'];
    if (readonly && String(tagName || '').toLowerCase() !== 'select') return ['CLICK'];
    if (family === 'date-input') return ['TYPE_TEXT', 'CLICK'];
    if (family === 'autocomplete' && role === 'textbox') return ['TYPE_TEXT', 'CLICK'];
    if (family === 'text-input' || family === 'rich-text') return ['TYPE_TEXT'];
    if (family === 'native-select' || family === 'picker-column') return ['CLICK', 'SELECT'];
    if (['action', 'overlay-option', 'toggle', 'choice'].includes(family)) return ['CLICK'];
    return editable ? ['TYPE_TEXT'] : ['CLICK'];
  }

  function readValue(el, { family, hostname, tidy, editableText, isEditable, label }) {
    if (family === 'choice' && el.classList?.contains('cur')) return tidy(el.textContent || '');
    if (el.tagName === 'SELECT') return el.options?.[el.selectedIndex]?.text || '';
    if (isEditable(el)) return editableText(el).slice(0, 200);
    if (family === 'virtual-select' && el.closest?.('.phoenix-select')) {
      const text = tidy(el.closest('.phoenix-select').innerText || el.closest('.phoenix-select').textContent || '');
      return /^(?:请选择|请输入)?$/.test(text) || text === tidy(label) ? '' : text;
    }
    if (el.matches?.('input,textarea')) {
      if (el.value) return el.value;
      const selectedDate = readAdjacentMokaDate(el, { family, hostname, tidy });
      if (selectedDate) return selectedDate;
      if (/(^|\.)mokahr\.com$/i.test(hostname) && ['virtual-select', 'autocomplete'].includes(family)) {
        let node = el.parentElement;
        for (let depth = 0; node && depth < 2; depth += 1, node = node.parentElement) {
          const text = tidy(node.innerText || node.textContent || '');
          const captionOnly = normalize(text).replace(/\*/g,'') === normalize(label).replace(/\*/g,'');
          if (text && !captionOnly && text !== tidy(el.getAttribute('placeholder') || '') &&
              !/^(?:请选择|请输入|必填项未填写)/.test(text) && text.length <= 60) return text;
        }
      }
      return '';
    }
    if (['virtual-select', 'autocomplete'].includes(family) || el.getAttribute?.('role') === 'combobox') {
      const text = tidy(el.innerText || el.textContent || '');
      if (text && normalize(text).replace(/\*/g,'') !== normalize(label).replace(/\*/g,'')) return text;
      return readAdjacentMokaDate(el, { family, hostname, tidy });
    }
    return el.value || '';
  }

  function readAdjacentMokaDate(el, { family, hostname, tidy }) {
    if (family !== 'virtual-select' || !/(^|\.)mokahr\.com$/i.test(hostname)) return '';
    const input = el.matches?.('input') ? el : el.querySelector?.('input[placeholder="年"],input[placeholder="月"]');
    const unit = input?.getAttribute('placeholder');
    if (!input) return '';
    if (unit !== '年' && unit !== '月') {
      for (let node = input.parentElement, depth = 0; node && depth < 5; node = node.parentElement, depth += 1) {
        if (node.querySelectorAll('input').length > 1) break;
        const direct = tidy(node.textContent || '');
        const numbers = direct.match(/\d+/g) || [];
        if (numbers.length === 1 && !/\p{L}/u.test(direct) &&
            /^\d{4}$|^(?:[1-9]|1[0-2])$/.test(numbers[0])) return numbers[0];
      }
      return '';
    }
    for (let node = input.parentElement, depth = 0; node && depth < 5; node = node.parentElement, depth += 1) {
      if (node.querySelectorAll('input').length > 1) break;
      const numbers = (tidy(node.textContent || '').match(/\d+/g) || []).filter(value =>
        unit === '年' ? /^\d{4}$/.test(value) : /^(?:[1-9]|1[0-2])$/.test(value));
      const unique = [...new Set(numbers)];
      if (unique.length === 1) return unique[0];
    }
    return '';
  }

  function stableKey(entry, occurrence) {
    return [entry.section, entry.context, entry.widgetFamily, entry.role, normalize(entry.label), occurrence]
      .filter(value => value !== undefined && value !== '').join('|');
  }

  function closeOpenTransactions(doc) {
    const init = { bubbles: true, cancelable: true, key: 'Escape', code: 'Escape', keyCode: 27, which: 27 };
    (doc.activeElement || doc).dispatchEvent(new KeyboardEvent('keydown', init));
    doc.dispatchEvent(new KeyboardEvent('keyup', init));
    doc.activeElement?.blur?.();
    for (const type of ['mousedown', 'mouseup', 'click']) {
      doc.body?.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 1, clientY: 1 }));
    }
  }

  root.JevWidgetDrivers = Object.freeze({ classify, operations, readValue, stableKey, closeOpenTransactions });
})(globalThis);
