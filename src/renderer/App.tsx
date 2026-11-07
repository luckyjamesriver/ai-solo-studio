import { useEffect, useState } from 'react';
import { studio, type EnvItem, type ProjectStatus } from './api.js';

// M0 外壳：环境体检 + 打开项目 + 初始化保存点。任务闭环界面在 M3 实现。
export function App() {
  const [env, setEnv] = useState<EnvItem[] | null>(null);
  const [project, setProject] = useState<ProjectStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    studio().detectEnvironment().then(setEnv).catch((e: Error) => setError(e.message));
  }, []);

  const wrap = (p: Promise<ProjectStatus | null>) =>
    p.then((r) => r && setProject(r)).catch((e: Error) => setError(e.message));

  return (
    <main className="shell">
      <h1>AI Solo Studio</h1>
      <p className="lede">你决定做什么，AI 负责实现，这里负责证明结果、控制风险、随时可撤销。</p>

      {error && <p role="alert" className="error">{error}</p>}

      <section aria-labelledby="env-h">
        <h2 id="env-h">你的电脑准备好了吗</h2>
        {!env ? <p>正在检查…</p> : (
          <ul className="env">
            {env.map((i) => (
              <li key={i.id} data-light={i.light}>
                <strong>{i.label}</strong>
                <span>{i.detail}</span>
                {i.help && <a href={i.help} target="_blank" rel="noreferrer">安装说明</a>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="proj-h">
        <h2 id="proj-h">项目</h2>
        {!project ? (
          <button onClick={() => wrap(studio().chooseProject())}>打开项目文件夹</button>
        ) : (
          <div>
            <p><strong>{project.name}</strong> <span className="muted">{project.path}</span></p>
            {!project.isRepo ? (
              <div className="consent">
                <p>这个文件夹还没有版本记录。开启后，AI 的每次修改都在独立副本中进行，你可以随时撤销或回到任何一个保存点。开启只会在文件夹中添加隐藏的版本记录，不会修改你的文件。</p>
                <button onClick={() => wrap(studio().initProject(true))}>开启版本记录并创建第一个保存点</button>
              </div>
            ) : (
              <>
                <h3>保存点</h3>
                <ol className="saves">
                  {project.savePoints.map((s) => <li key={s.sha}>{s.message} <span className="muted">{new Date(s.date).toLocaleString()}</span></li>)}
                </ol>
              </>
            )}
          </div>
        )}
      </section>
    </main>
  );
}
