# Vercel Sandbox 环境变量配置

## 问题

线上运行失败，错误信息：
```
Error: Vercel credentials not available: set VERCEL_TOKEN, or VERCEL_OIDC_TOKEN (+ optional VERCEL_TEAM_ID/VERCEL_PROJECT_ID).
```

## 解决方案

需要在 Vercel 项目的 **Environment Variables** 中配置以下变量：

### 方案 1：使用 VERCEL_TOKEN（推荐）

1. 获取 Personal Access Token：
   - 访问 https://vercel.com/account/tokens
   - 创建新 token，复制保存

2. 获取 Team ID 和 Project ID：
   ```bash
   # 本地运行（需要先 vercel link）
   vercel env ls
   # 或者从 Vercel Dashboard URL 获取
   # https://vercel.com/[TEAM_ID]/[PROJECT_NAME]
   ```

3. 在 Vercel 项目设置中添加环境变量：
   - `VERCEL_TOKEN` = `your_personal_access_token`
   - `VERCEL_TEAM_ID` = `team_xxx`
   - `VERCEL_PROJECT_ID` = `prj_xxx`

### 方案 2：使用 OIDC（自动获取 team/project）

Vercel 会自动注入 `VERCEL_OIDC_TOKEN`，但需要在项目设置中启用。

1. 在 Vercel 项目设置中启用 OIDC
2. `VERCEL_OIDC_TOKEN` 会自动包含 `owner_id` 和 `project_id`

## 配置步骤

1. 进入 Vercel 项目：https://vercel.com/maidangzhu/cloud-agent-platform
2. 点击 **Settings** → **Environment Variables**
3. 添加以上变量（选择方案 1 或 2）
4. 选择环境：**Production**, **Preview**, **Development**（全选）
5. 点击 **Save**
6. 重新部署项目（或等待下次部署）

## 验证

部署完成后，访问首页发消息，应该能看到沙箱正常创建和运行。

## 相关文件

- `src/server/sandbox/vercel-credentials.ts` - 凭证解析逻辑
- `src/server/sandbox/factory.ts` - 沙箱创建入口
