# 甘特圖部署到 GitHub Pages

這個網站使用一組共用的 Supabase 電子郵件與密碼。登入後可建立、開啟、修改和刪除同一個雲端專案庫中的專案。按「儲存」才會更新雲端，儲存時會比對版本。

## 1. 設定 Supabase

1. 建立 Supabase 專案，在 **SQL Editor** 執行 [supabase/schema.sql](supabase/schema.sql)。
2. 在 **Authentication → Users** 建立一個電子郵件使用者，設定密碼並確認電子郵件。將該使用者的 **User UID** 複製下來。在 **Authentication** 的註冊設定關閉新使用者自行註冊，並保持 Email 登入啟用。
3. 在 **SQL Editor** 執行以下指令，先把範例 UUID 換成共用使用者的 User UID。這一列指定專案庫唯一允許登入的帳號。

```sql
insert into gantt_private.shared_account (singleton, user_id)
values (true, '00000000-0000-0000-0000-000000000000')
on conflict (singleton) do update set user_id = excluded.user_id;
```

4. 在 [supabase-config.js](supabase-config.js) 填入 **Project URL** 和 **Publishable key**。GitHub Pages 會公開提供此檔案，因此帳號密碼、Secret key、`service_role` 金鑰及專案 JSON 備份應留在網站檔案之外。

## 2. 發布網站

將此資料夾的網站檔案推到 GitHub 儲存庫的 `main`。在儲存庫的 **Settings → Pages** 選擇 **Deploy from a branch**，來源選 **main / (root)**。發布後開啟 Pages 網址並用共用帳號登入。[GitHub Pages 設定說明](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)

直接開啟 `gantt.html`（`file://`）仍可使用原本的本機專案庫。透過 HTTP 或 HTTPS 開啟預設使用雲端版。若舊版曾在網頁上使用，可在相同網址的 `gantt.html` 後加上 `?local=1`，開啟該瀏覽器原有的本機專案庫以匯出資料。

## 3. 搬遷與確認

- 在原本存有專案的瀏覽器與網址開啟專案，按「匯出專案檔」。然後在 GitHub Pages 網站登入，按「匯入專案檔」建立一份雲端專案。
- 用兩個瀏覽器登入，分別開啟同一個專案。在第一個瀏覽器修改並儲存後，從第二個瀏覽器儲存舊版本，畫面應顯示「版本衝突」。可以先另存新檔保留修改，或重新開啟專案載入雲端版本。
- 共用帳號的使用者權限相同，所有人都能刪除專案。Supabase 會以這個帳號辨識操作，無法區分個別使用者。
