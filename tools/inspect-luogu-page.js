// Run manually in Luogu DevTools. May GET the current document; never submits.
// This is not an extension entrypoint and adds no interface.
(async () => {
  if (location.origin !== 'https://www.luogu.com.cn') {
    throw new Error('请在洛谷原站页面运行此只读采集脚本')
  }
  const initialPathname = location.pathname
  const recordPath = initialPathname.match(/^\/record\/([1-9]\d{0,19})$/)
  const problemPath = initialPathname.match(/^\/problem\/([PB][1-9]\d*)$/)
  const matchesRoute = (context) => {
    if (recordPath) return context?.template === 'record.show'
      && String(context.data?.record?.id || '') === recordPath[1]
    if (problemPath) return context?.template === 'problem.show'
      && context.data?.problem?.pid === problemPath[1]
    return false
  }

  const visible = (element) => {
    const box = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return box.width > 0 && box.height > 0 && style.display !== 'none'
      && style.visibility !== 'hidden'
  }
  const languageLabel = /^(?:C(?:\+\+)?(?:\d{2})?|Pascal|Python|JavaScript|Java|Ruby|Go|Rust|PHP|C#|Visual Basic|Haskell|Kotlin|Scala|Perl|F#|OCaml|Julia)(?=$|[\s(/])/i
  const languageOption = (element) => {
    const label = String(element.textContent || '').replace(/\s+/g, ' ').trim()
    if (!label || label.length > 200 || !languageLabel.test(label)) return null
    const rawId = element.getAttribute('data-value') || element.getAttribute('data-id')
      || element.getAttribute('value') || ''
    return {
      label,
      // Do not infer an ID from the label or from the reference language table.
      id: /^\d{1,6}$/.test(rawId) ? rawId : null,
      selected: element.getAttribute('aria-selected') === 'true',
      disabled: element.getAttribute('aria-disabled') === 'true'
        || Boolean(element.disabled),
    }
  }
  const controlStructure = (element, depth = 0) => ({
    tag: element.tagName.toLowerCase(),
    classes: Array.from(element.classList).filter((name) => /^[A-Za-z_][A-Za-z0-9_-]{0,70}$/.test(name)).slice(0, 8),
    role: element.getAttribute('role'),
    children: depth < 3 ? Array.from(element.children).slice(0, 5)
      .map((child) => controlStructure(child, depth + 1)) : [],
  })

  const components = new Set()
  const queue = []
  for (const element of document.querySelectorAll('*')) {
    if (element.__vueParentComponent) queue.push(element.__vueParentComponent)
    if (queue.length >= 20000) break
  }
  while (queue.length && components.size < 2000) {
    const component = queue.pop()
    if (!component || components.has(component)) continue
    components.add(component)
    if (component.parent) queue.push(component.parent)
  }

  const componentName = (component) => String(
    component.type?.__name || component.type?.name || 'anonymous',
  ).slice(0, 100)
  const languageControls = []
  const editorComponents = []
  for (const component of components) {
    const props = component.props || {}
    const vnodeProps = component.vnode?.props || {}
    const updater = vnodeProps['onUpdate:modelValue']
    const hasModelUpdater = typeof updater === 'function'
      || (Array.isArray(updater) && updater.some((item) => typeof item === 'function'))
    if (Array.isArray(props.options) && /lang/i.test(String(vnodeProps.class || ''))) {
      languageControls.push({
        component: componentName(component),
        hasModelUpdater,
        valueType: typeof props.modelValue,
        options: props.options.slice(0, 200).map((option) => ({
          value: ['string', 'number'].includes(typeof option?.value) ? option.value : null,
          label: typeof option?.label === 'string' ? option.label.slice(0, 200) : null,
          disabled: Boolean(option?.disabled),
        })),
      })
    }
    if (typeof props.modelValue === 'string' && typeof props.language === 'string') {
      editorComponents.push({
        component: componentName(component),
        hasModelUpdater,
        modelType: 'string',
        modelLength: props.modelValue.length,
        language: props.language.slice(0, 100),
        propKeys: Object.keys(props).filter((key) => !/^on/.test(key)).slice(0, 40),
      })
    }
  }

  const nativeLanguageControls = Array.from(document.querySelectorAll('select'))
    .filter((select) => /lang/i.test(`${select.name} ${select.id} ${select.className}`))
    .map((select) => ({
      tag: 'select',
      options: Array.from(select.options).slice(0, 200).map((option) => ({
        value: option.value,
        label: option.textContent.trim().slice(0, 200),
        disabled: option.disabled,
      })),
    }))

  // Production builds may omit Vue's DOM hooks. Inspect real custom controls too.
  const customLanguageControls = Array.from(document.querySelectorAll('.lang-select, [role="listbox"]'))
    .filter(visible)
    .slice(0, 20)
    .map((element) => ({
      role: element.getAttribute('role'),
      isLanguageControl: element.matches('.lang-select'),
      ariaExpanded: element.getAttribute('aria-expanded'),
      structure: controlStructure(element),
      options: Array.from(element.querySelectorAll('*'))
        .filter((child) => child.childElementCount === 0 && visible(child))
        .map(languageOption).filter(Boolean).slice(0, 200),
    }))
  // Some dropdowns teleport their menu outside the original control.
  const visibleLanguageOptions = Array.from(document.querySelectorAll('[role="option"]'))
    .filter(visible).map(languageOption).filter(Boolean).slice(0, 200)
  const editorDom = Array.from(document.querySelectorAll(
    '.monaco-editor, .ace_editor, .cm-editor, .CodeMirror, textarea, [contenteditable="true"]',
  )).filter(visible).slice(0, 30).map((element) => ({
    tag: element.tagName.toLowerCase(),
    kind: element.matches('.monaco-editor') ? 'monaco'
      : element.matches('.ace_editor') ? 'ace'
        : element.matches('.cm-editor, .CodeMirror') ? 'codemirror'
          : element.matches('textarea') ? 'textarea' : 'contenteditable',
    inCodeArea: Boolean(element.closest('.code-area')),
    readOnly: element.hasAttribute('readonly') || element.getAttribute('aria-readonly') === 'true',
  }))
  const submitNavigation = Array.from(document.querySelectorAll('a, button, [role="tab"]'))
    .filter(visible)
    .filter((element) => /^(?:提交代码|提交|代码提交|Submit(?: Code)?)$/i.test(String(element.textContent || '').trim()))
    .slice(0, 20).map((element) => ({
      tag: element.tagName.toLowerCase(),
      label: element.textContent.trim(),
      selected: element.getAttribute('aria-selected') === 'true'
        || element.classList.contains('active') || element.classList.contains('selected'),
      hash: (() => {
        try {
          const hash = new URL(element.getAttribute('href') || '', location.href).hash
          return /^#[A-Za-z0-9_-]{1,100}$/.test(hash) ? hash : null
        } catch { return null }
      })(),
    }))

  // Describe known data containers without printing their values or free text.
  let shapeNodes = 0
  const shape = (value, depth = 0) => {
    if (++shapeNodes > 600) return '(truncated)'
    if (value === null) return 'null'
    if (depth > 5) return Array.isArray(value) ? 'array' : typeof value
    if (Array.isArray(value)) return { type: 'array', length: value.length, item: value.length ? shape(value[0], depth + 1) : null }
    if (typeof value !== 'object') return typeof value
    return Object.fromEntries(Object.keys(value).slice(0, 60)
      .filter((key) => !/cookie|token|csrf|captcha|password/i.test(key))
      .map((key) => [key, shape(value[key], depth + 1)]))
  }
  const contexts = {}
  for (const key of ['_feInjection', '__INITIAL_STATE__']) {
    const value = window[key]
    if (value && typeof value === 'object') contexts[key] = value
  }
  const contextScript = document.querySelector('script#lentille-context[type="application/json"]')
  if (contextScript) {
    try { contexts.lentille = JSON.parse(contextScript.textContent) } catch { /* Report absent data. */ }
  }
  // Lentille leaves the initial script unchanged after SPA navigation. On a
  // record page, always request a fresh document rather than trusting that snapshot.
  const documentRead = { attempted: false, httpStatus: null, error: null }
  if (recordPath || (problemPath && !matchesRoute(contexts.lentille))) {
    documentRead.attempted = true
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10000)
    try {
      const response = await fetch(`${location.origin}${initialPathname}`, {
        method: 'GET', credentials: 'same-origin', mode: 'same-origin',
        cache: 'no-store', redirect: 'error', headers: { Accept: 'text/html' },
        signal: controller.signal,
      })
      documentRead.httpStatus = response.status
      if (!response.ok) documentRead.error = 'http_error'
      else if (!/text\/html/i.test(response.headers.get('content-type') || '')) documentRead.error = 'not_html'
      else {
        const html = await response.text()
        if (html.length > 3 * 1024 * 1024) documentRead.error = 'document_too_large'
        else {
          const parsed = new DOMParser().parseFromString(html, 'text/html')
          const node = parsed.querySelector('script#lentille-context[type="application/json"]')
          let current = null
          try { current = JSON.parse(node?.textContent || 'null') } catch { /* Report missing context. */ }
          if (location.pathname !== initialPathname) documentRead.error = 'route_changed'
          else if (!current) documentRead.error = 'missing_context'
          else if (!matchesRoute(current)) {
            documentRead.error = recordPath && current.template === 'record.show'
              ? 'record_id_mismatch' : 'context_route_mismatch'
          } else contexts.currentDocument = current
        }
      }
    } catch (error) {
      documentRead.error = error.name === 'AbortError' ? 'request_timeout' : 'request_failed'
    } finally {
      clearTimeout(timer)
    }
  }
  const recordShapes = {}
  const contextKeys = {}
  const contextShapes = {}
  const contextFreshness = {}
  for (const [name, context] of Object.entries(contexts)) {
    if (!context || typeof context !== 'object') continue
    const matchesCurrentRoute = matchesRoute(context)
    contextFreshness[name] = {
      source: name === 'currentDocument' ? 'current_document_get' : 'initial_snapshot',
      matchesCurrentRoute,
    }
    contextKeys[name] = Object.keys(context).filter((key) => !/cookie|token|csrf|captcha|password/i.test(key)).slice(0, 60)
    const record = context.currentData?.record || context.data?.record || context.record
    if (name === 'currentDocument' && matchesCurrentRoute && record && typeof record === 'object') recordShapes[name] = shape(record)
    contextShapes[name] = {
      template: typeof context.template === 'string' && /^[A-Za-z0-9_./:-]{1,120}$/.test(context.template)
        ? context.template : typeof context.template,
      data: matchesCurrentRoute ? shape(context.data) : '(initial context does not match current route)',
      user: shape(context.user),
    }
  }

  const frames = Array.from(document.querySelectorAll('iframe')).slice(0, 20).map((frame) => {
    let sameOriginAccessible = false
    try { sameOriginAccessible = Boolean(frame.contentDocument) } catch { /* Cross-origin. */ }
    return { visible: visible(frame), sameOriginAccessible }
  })
  const scriptAssets = Array.from(document.scripts).flatMap((script) => {
    if (!script.src) return []
    try {
      const url = new URL(script.src, location.href)
      if (!['https://fecdn.luogu.com.cn', location.origin].includes(url.origin)) return []
      return [`${url.origin}${url.pathname}`]
    } catch { return [] }
  }).slice(0, 30)

  const report = {
    collectorVersion: 3,
    collectedAt: new Date().toISOString(),
    page: {
      origin: location.origin,
      pathname: initialPathname,
      hash: /^#[A-Za-z0-9_-]{1,100}$/.test(location.hash) ? location.hash : null,
      readyState: document.readyState,
    },
    languageControls,
    nativeLanguageControls,
    editorComponents,
    vueComponentHooksFound: components.size,
    customLanguageControls,
    visibleLanguageOptions,
    editorDom,
    editorRuntime: {
      monacoModelApi: typeof window.monaco?.editor?.getModels === 'function',
      aceApi: typeof window.ace?.edit === 'function',
    },
    submitNavigation,
    frames,
    scriptAssets,
    submitComponentFound: Array.from(components).some((component) => componentName(component) === 'ProblemSubmitBlock'),
    contextKeys,
    contextShapes,
    contextFreshness,
    documentRead,
    recordShapes,
    notes: [
      '只读取公开控件和字段类型；必要时只读 GET 当前地址，不修改页面、不提交代码。',
      'lentille-context 是初始快照，SPA 跳转后可能与地址不一致；记录结构只采纳 RID 匹配的新文档。',
      recordPath ? '记录页没有编辑器或语言控件属正常情况；请提供 recordShapes、contextFreshness 和 documentRead。'
        : '题目页没有 recordShapes 属正常情况；采集语言时先打开原站提交区和语言菜单。',
    ],
  }
  console.info(JSON.stringify(report, null, 2))
  return report
})()
