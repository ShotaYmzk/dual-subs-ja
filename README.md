# Dual Subs JA (PLaMo)

Prime Video・Netflix・YouTube の英語字幕の下に、日本語の訳を添える Chrome 拡張機能です。
翻訳は [PLaMo 3 Translate](https://huggingface.co/collections/pfnet/plamo-3-translate) を**あなたのPCの中**（WebGPU / CPU）で動かすので、字幕は外部に送信されません。

*Adds Japanese next to the English subtitles of Prime Video, Netflix and YouTube. Translation runs on your own device with PLaMo 3 Translate; subtitles never leave your computer.*

> 非公式です。Preferred Networks, Inc. および Amazon とは関係ありません。Built with PLaMo.

## 機能
- 字幕を先読みして翻訳（再生位置から先のセリフを順に）
- 対訳表示 / 日本語のみ / 英語のみ、字幕を映像に重ねる／画面の下の帯に出す
- 英単語にポインタを乗せると意味を表示（動画は一時停止）
- セリフ一覧パネル（クリックでその場面へ）、セリフごとの自動停止、キー操作（A / S / D）
- 英語字幕がない作品は、日本語字幕を英語に翻訳して対訳表示
- 用語集（固有名詞の訳を固定）
- ブラウザ内蔵エンジン（追加インストール不要）／ 上級者向けに Ollama も選べます
- 対応サイト: Prime Video / Netflix / YouTube（Netflix は実機での確認がまだです）

## インストール（ソースから）
1. このリポジトリを clone する（`prime-subs-ja/vendor/wllama/` のビルド済みファイルを含みます）
2. Chrome で `chrome://extensions` を開き、デベロッパーモードをオン
3. 「パッケージ化されていない拡張機能を読み込む」で `prime-subs-ja/` フォルダを選ぶ
4. 開いた案内画面で、翻訳モデル（標準 約573MB）を取得する（初回のみ）

要件: Chrome 137 以降、メモリ 8GB 以上を推奨。

## ストア用 zip の作り方
```bash
bash release/build.sh      # release/dual-subs-ja-<version>.zip ができます
```
公開用の説明文・権限の説明・チェックリストは [`store/`](store/) にあります。

## ライセンスについて
- このリポジトリの**自作コード**は MIT License（[LICENSE](LICENSE)）です。
- **翻訳モデル（PLaMo 3 Translate）は同梱していません。** 初回に Hugging Face から取得します。モデルは PLaMo Community License で提供されます。個人・学術目的は登録なしで利用できます。**仕事・商用の利用には、Preferred Networks への事前登録が必要**です（年間売上10億円以下などの条件があります）。詳細は公式の規約を確認してください: <https://plamo.preferredai.jp/info/plamo-community-license-ja>
- 同梱のサードパーティ（wllama, llama.cpp, Emscripten, Dawn）とそのライセンスは [`prime-subs-ja/NOTICE.txt`](prime-subs-ja/NOTICE.txt) と `prime-subs-ja/licenses/` にあります。
- `prime-subs-ja/vendor/wllama/` の WebAssembly は、[jammaru/sakutto](https://github.com/jammaru/sakutto)（MIT）が公開しているビルド手順とパッチで、固定したバージョンの [wllama](https://github.com/ngxson/wllama) / llama.cpp をビルドしたものです（`wllama-build.json` に出所を記録）。
- 「Prime Video」は Amazon.com, Inc. またはその関連会社の商標です。

## English

Chrome extension that shows a Japanese translation under Prime Video's English subtitles (or an English translation of Japanese subtitles). Translation runs locally with PLaMo 3 Translate via WebGPU/CPU in an offscreen document; no subtitle text is sent anywhere. The only network access is downloading the model from Hugging Face.

Install from source: clone, open `chrome://extensions`, enable Developer mode, "Load unpacked" → `prime-subs-ja/`. Build the Web Store package with `bash release/build.sh`.

The model is **not** bundled and is licensed under the PLaMo Community License (commercial use requires prior registration with Preferred Networks). Unofficial; not affiliated with Preferred Networks or Amazon. Built with PLaMo.
