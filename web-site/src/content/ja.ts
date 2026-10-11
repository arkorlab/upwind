import type { Copy } from './copy.ts';

/**
 * The site in Japanese, served under `/ja`.
 *
 * A translation of what the English says, not a gloss of it: the sentences are Japanese sentences,
 * and the names — `next build`, `upwind dev`, `.arkor/` — are the same names, because they are what
 * a reader types.
 */
export const ja = {
  meta: {
    title: 'upwind — Next.js のデプロイ用アダプター',
    description:
      'upwind は next build の中で動き、デプロイ用のバンドルを書き出します。すべてのルート、プリレンダー、静的ファイルを内容で識別し、それらを配信する Function まで含めて。対応は Next.js 16.3 以降の 16 系。',
    siteName: 'upwind',
    ogImageAlt: 'upwind — Next.js のデプロイ用アダプターと、それが作ったものを配信するランタイム',
  },
  nav: {
    skipToContent: '本文へ',
    repository: 'GitHub',
    npm: 'npm',
  },
  hero: {
    tagline: 'Next.js のデプロイ用アダプターと、それが作ったものを配信するランタイム。',
    body: 'アダプターはあなたの `next build` の中で動き、デプロイ用のバンドルを書き出します。すべてのルート、プリレンダー、静的ファイルを内容で識別し、アプリのコードを実行する Function まで含めて。ビルドはどこにも通信せず、認証情報も要りません。出てくるのは 1 つのディレクトリーで、それをアップロードするのはホスト側の仕事です。',
    commandCaption: 'アプリを作る',
    commandNote:
      'Tailwind 4 入りの Next.js 16 アプリを upwind に配線した状態で書き出し、そのままインストールします。',
    primary: 'GitHub で読む',
    secondary: 'npm のパッケージ',
  },
  bundle: {
    title: 'ビルドが書き出すもの',
    body: 'Next.js は自身の Adapter API を通じてアダプターを呼びます。ビルド前に `modifyConfig`、ビルド後に `onBuildComplete`。デプロイに必要なものはすべて 1 つのディレクトリー `.arkor/` の下に書き出されます。',
    items: [
      {
        term: '`bundle.json`',
        description:
          'エントリーポイント、プリレンダー、ルーティング表、ヘッダー規則、キャッシュ寿命のプロファイル。何を配信するか、そして何を Function ではなくストレージから配信できるか。',
      },
      {
        term: '内容で識別される blob',
        description:
          'プリレンダー済みのシェルと静的ファイルを、その中身のハッシュで識別します。1 ページだけ変わったデプロイが運ぶのは 1 つの blob です。',
      },
      {
        term: '`app` Function',
        description:
          'アプリ自身のコードを、ページ、Route Handler、キャッシュとともにバンドルしたもの。',
      },
      {
        term: '`middleware` Function',
        description:
          'プロジェクトの `proxy.ts` を別に組み立てたもの。rewrite だけで済むリクエストがアプリを起こすことはありません。',
      },
    ],
    note: 'アダプターは外部サービスと一切通信しません。バンドルを作るだけなら、どのアカウントも必要ありません。',
  },
  dev: {
    title: '開発中も、玄関がある',
    body: 'デプロイされたアプリの前にはエッジがいて、プラットフォーム自身のパスはエッジが答えます。`next dev` にはそのエッジがいません。`upwind dev` がローカルでの玄関です。ポートを持ち、自分のパスには自分で答え、それ以外のすべてをプロジェクト自身の Next.js に渡します。開発バンドラー、HMR、エラーオーバーレイは Next.js のものそのままです。',
    endpoints: [
      {
        term: '`/__upwind`',
        description:
          'この実行が何であるか。各バージョン、アドレス、プロジェクトのディレクトリー、名指したアダプター。',
      },
      {
        term: '`/__upwind/health`',
        description: 'Next.js の準備ができたら `200`、起動中は `503`。',
      },
    ],
    note: '答えるのはアプリではなく玄関です。だからアプリがまだコンパイル中でも、そのコンパイルが失敗している最中でも答えます。',
  },
  serves: {
    title: '配信できるもの',
    body: 'アプリが何で出来ていても、1 回のビルドから 1 つのバンドル。',
    items: [
      {
        term: 'App Router',
        description:
          'Server Components とストリーミング。プリレンダー済みのシェルをストレージから配信し、その続きを Function が再開します。',
      },
      {
        term: 'Pages Router',
        description:
          'クライアントのルーターが名前で要求する `_next/data` の出力も、ビルド ID の下でそのまま。',
      },
      {
        term: '画像',
        description: '`/_next/image` をエッジで最適化。形式とサイズはアプリの設定どおりに。',
      },
      {
        term: '`proxy.ts`',
        description:
          'プロジェクトの proxy はそれ自体が 1 つの Function になり、リクエストがアプリに届く前に動きます。',
      },
      {
        term: '定期実行',
        description:
          '`next.config` の隣で宣言した cron をビルド時に検査し、通ったものをバンドルに載せます。',
      },
      {
        term: '静的エクスポート',
        description:
          '`output: export` でも同じバンドルを、サーバー側を空にして書き出します。どの文書もストレージから。',
      },
      {
        term: 'WebAssembly',
        description: 'コンパイル済みモジュールは、それを読むコードの Function と一緒に運ばれます。',
      },
      {
        term: '`next/og`',
        description:
          'Open Graph 画像は、静的なルートならビルドが、そうでなければ Function が描きます。このページが共有するカードもその 1 つです。',
      },
    ],
    rangeLabel: 'Next.js',
    rangeNote:
      'アダプターによる Next.js 自身の出力の書き換えが、この範囲のすべてのリリースと canary に対して検査されています。',
  },
  packages: {
    title: '1 つのリリース、1 つの世代',
    body: 'ここにあるパッケージのバージョンは互いに足並みを揃えて動き、1 つの署名付きタグから公開されます。プロジェクトを作るものと、それを動かすものが、つねに同じ世代です。',
    summaries: {
      upwind:
        'CLI。`upwind dev` はプロジェクト自身の Next.js を upwind の玄関の後ろで動かし、`upwind build` はプロジェクト自身の `next build` にアダプターを名指して渡します。',
      adapter:
        '`next build` の中で動き、バンドルを書き出し、書き出したものを配信する Function を組み立てます。',
      runtime:
        'デプロイされたFunctionの中身。アプリを配信するためのルーティング表、middleware、プリレンダー、キャッシュ。',
      core: '他のパッケージが話す語彙。バンドルの形、キャッシュの用語、エッジと Function のあいだのプロトコル。',
      sdk: 'アプリ自身の D1、KV、R2。ローカルでもデプロイ先でも同じ書き方で読め、設定はいりません。',
      create: '`pnpm create upwind` と、それが書き出すアプリ。',
    },
    npmLabel: 'npm',
    readmeLabel: 'Readme',
  },
  status: {
    title: '1.0 の前',
    body: '初期のソフトウェアです。使ってから気づくのではなく、先に書いておきます。',
    points: [
      'デプロイ用バンドルは自身のバージョンを持ち、形が落ち着くまでは変わる前提です。',
      '1 つ前のマイナーのための互換用の層を、どのリリースも持ちません。',
      'ここで誰も見たことのないビルドが、いちばん役に立つ報告です。あなたのアプリがしていて、これがまだ配信できていないこと。',
    ],
    licence: { label: 'ライセンス', conjunction: 'または', note: '（受け取る側が選べます）' },
    contributing: '貢献の仕方',
    issues: '不具合を報告する',
  },
  footer: {
    builtWith:
      'このサイトは Next.js アプリです。`upwind build` がビルドし、Arkor がホストしています。',
    repository: 'GitHub',
    npm: 'npm',
    licence: 'ライセンス',
  },
  notFound: {
    title: 'ここにはありません',
    body: 'そのアドレスにページはありません。',
    home: 'トップへ戻る',
  },
} satisfies Copy;
