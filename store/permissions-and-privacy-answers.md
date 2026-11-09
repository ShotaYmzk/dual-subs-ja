# ダッシュボードの「プライバシー」タブに貼り付ける回答

## 単一の目的（Single purpose）
Prime Video の字幕テキストを翻訳し、動画の上または下に対訳として表示する。

## 権限の使用理由（Permission justification）

| 権限 | 貼り付け用の説明 |
|---|---|
| storage | 表示設定、選択したモデル、用語集を保存するため。 |
| offscreen | 翻訳エンジン（WebAssembly の llama.cpp）を動かすため。Web Worker とマルチスレッドが必要で、サービスワーカーでは動かせないため、オフスクリーン文書で動かす。 |
| declarativeNetRequest | 任意機能（手元の Ollama サーバーを翻訳エンジンに使う場合）のためだけに使用。Ollama は chrome-extension:// 由来のリクエストを拒否するので、この拡張自身が localhost:11434 へ送るリクエストの Origin ヘッダを外す。他のサイトのリクエストは変更しない。 |

## ホスト権限（Host permissions）
| ホスト | 説明 |
|---|---|
| https://*.primevideo.com/*, https://*.amazon.co.jp/gp/video/*, https://*.amazon.com/gp/video/*（および `/-/*/gp/video/*`） | Prime Video のプレイヤーが読み込む字幕ファイルを読み取り、翻訳を重ねて表示するため（コンテンツスクリプト）。上記以外のページでは動作しない。 |
| https://huggingface.co/*, https://*.huggingface.co/*, https://*.hf.co/* | 翻訳モデル（GGUF）を Hugging Face から取得するため。取得時に配信用サーバーへ転送される。 |
| http://localhost:11434/*, http://127.0.0.1:11434/* | 任意機能。ユーザーが自分の PC で動かしている Ollama に翻訳を依頼するため。 |

## その他の技術的な説明（質問された場合）
- **MAIN world のスクリプト（hook.js）**: プレイヤーが字幕ファイルを取得する fetch / XMLHttpRequest の応答を読むために、ページ側で応答を観察する。読み取った字幕テキストは拡張内でのみ使い、外部へ送らない。
- **CSP の `wasm-unsafe-eval`**: WebAssembly（llama.cpp）を実行するために必要。`eval` や `new Function` は使っていない。
- **cross_origin_embedder_policy / cross_origin_opener_policy**: WebAssembly のマルチスレッド（SharedArrayBuffer）に必要。拡張のページにだけ適用される。

## リモートコードを使用していますか？
**いいえ。** すべての JavaScript と WebAssembly はパッケージに同梱している。ダウンロードするのは翻訳モデルの重み（データ）だけで、実行コードではない。

## ユーザーデータの扱い（Data usage）
- 収集するデータ: 「ウェブサイトのコンテンツ」にチェックするのが安全（字幕テキストを読み取るため）。ただし**外部へ送信せず、保存もしない**。迷う場合は、この点を説明欄とプライバシーポリシーに明記して整合させる。
- 他のカテゴリ（個人を特定できる情報、健康、財務、認証情報、位置情報、ウェブ履歴、ユーザーのアクティビティ 等）: チェックしない。
- 3つの証明（すべてチェック）:
  - 承認された用途以外で、ユーザーデータを第三者に販売・転送しない
  - 単一の目的と無関係な目的でユーザーデータを使用・転送しない
  - 信用度の判定や融資の目的でユーザーデータを使用・転送しない

## テスト用の手順（審査員向け・Test instructions）
審査員が Prime Video に加入していない可能性があるので、次を書く。
```
This extension adds Japanese translations to Prime Video subtitles. A Prime Video subscription is required to see it on the video page, so a demo video is linked below: <デモ動画のURL>
Without a subscription, you can verify the engine itself:
1. After installing, the setup page opens. Click "取得する" (Get) for the standard model and wait until it finishes (about 573 MB).
2. Click "試しに訳す" (Translate a test sentence). It should show a Japanese translation of "Hello, how are you?".
3. Open the extension's toolbar popup > "詳しい設定" (Settings) > "状態" > "翻訳の速さを測る" (Measure speed) to translate sample sentences.
The extension makes no network requests other than downloading the model from huggingface.co.
```
