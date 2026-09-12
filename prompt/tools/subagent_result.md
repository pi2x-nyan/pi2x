---
label: 子代理结果/状态
---

取一个子任务（run_task 返回的 taskId）的当前状态与输出结果。

返回：`status`（pending/running/done/failed/aborted）+ 截至当前的输出文本。

用法：run_task 启动后，用此工具查子代理是否完成、看中间输出；任务 done 后取最终结果。若 status 非 done，可稍后再取。
