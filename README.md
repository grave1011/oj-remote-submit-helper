# OJ Remote Submit Helper Lite

用于 **SDUST Judge 浏览器辅助远程提交（Browser Submit）** 的 Chrome MV3 扩展。

支持的平台：

- AtCoder
- Codeforces
- Codeforces Gym

当 SDUST Judge 以 **Browser Submit** 模式进行远程判题时，本扩展会自动打开目标 OJ 的提交页面，尽可能自动填写提交表单，在用户完成验证码、人机验证或最终确认后，自动获取提交记录（Submission ID）并返回给 SDUST Judge。

本扩展**不会**向 SDUST Judge 后端发送以下任何敏感信息：

- AtCoder Cookie
- Codeforces Cookie
- CSRF Token
- 用户密码
- 登录凭据

---

# 目录结构

- `manifest.json`：扩展配置文件
- `background.js`：浏览器提交流程调度及各 OJ 自动化逻辑
- `page-bridge.js`：SDUST Judge 页面与扩展之间的通信桥接
- `CHANGELOG.md`：版本更新记录
- `PRIVACY.md`：隐私政策说明
- `RELEASE.md`：发布与打包说明
- `build-release.sh`：生成发布 ZIP 包脚本

---

# 本地安装（开发测试）

1. 打开 `chrome://extensions`
2. 开启 **开发者模式**
3. 点击 **加载已解压的扩展程序（Load unpacked）**
4. 选择目录：

```
chrometools/oj-remote-submit-helper-lite
```

5. 在当前 Chrome 配置中登录目标 OJ（AtCoder / Codeforces）
6. 在 SDUST Judge 中发起 Browser Submit 提交即可使用。

---

# 各平台工作流程

## AtCoder

- 自动打开 AtCoder 提交页面
- 如遇验证码或人机验证，等待用户完成
- 自动填写：
  - 题目
  - 编程语言
  - 源代码
- **不会自动点击最终 Submit 按钮**
- 用户手动提交后，自动监听页面变化，并将 Submission ID 与提交状态返回给 SDUST Judge

---

## Codeforces

- 自动打开比赛或 Problemset 提交页面
- 检查当前浏览器是否已登录 Codeforces
- 自动填写：
  - 比赛编号
  - 题号
  - 编程语言
  - 源代码
- **不会绕过 Cloudflare、Turnstile 等反机器人验证**
- **不会自动点击最终 Submit 按钮**
- 用户提交完成后自动检测 Submission ID，并返回提交状态

---

## Codeforces Gym

- 使用与 Codeforces 相同的 Browser Submit 流程
- 支持 Gym 比赛页面提交
- 支持识别并返回 Gym 提交记录（Submission URL / Submission ID）

---

# Lite 版本说明

Lite 版本在所有支持的平台均保持统一的交互方式：

- AtCoder：自动填写，用户手动点击提交
- Codeforces：自动填写，用户手动点击提交
- Codeforces Gym：自动填写，用户手动点击提交

扩展不会替用户完成最终提交操作。

---

# 权限说明

本扩展申请以下 Chrome 权限：

### tabs

用于打开并管理 Browser Submit 创建的提交页面标签。

### scripting

用于在支持的网站中执行页面辅助脚本，实现自动填写及结果检测。

### host_permissions

当前包含：

- `https://atcoder.jp/*`
- `https://codeforces.com/*`
- `<all_urls>`（用于 SDUST Judge 页面桥接及 Browser Submit 入口页面）

如果 Chrome Web Store 审核要求进一步收紧权限范围，将优先缩小 `<all_urls>` 的匹配范围。

---

# 打包发布

执行：

```bash
./build-release.sh
```

脚本将在 `dist/` 目录生成带版本号的 ZIP 发布包。

---

# 推荐发布方式

- **正式发布：** Chrome Web Store
- **内部测试或临时分发：** 使用仓库生成的 ZIP 包

---

# 与 SDUST Judge 的关联文件

Browser Submit 功能主要由以下页面触发：

- `frontend/src/views/problems/Problems.vue`
- `frontend/src/views/problems/SolutionResult.vue`

这些页面负责启动 Browser Submit 流程，并等待扩展返回提交结果。
