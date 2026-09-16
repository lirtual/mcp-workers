# V1 Tools

Read tools (always registered): `get_capabilities`, `list_files`, `list_dirs`, `get_file_info`, `search_files`, `get_download_url`, `list_tasks`, `get_task_info`.

Write tools (omitted when `OPENLIST_READONLY=true`): `create_folder`, `rename`, `copy`, `move`, `remove`, `upload_file`, `retry_task`, `cancel_task`, `delete_task`.

`remove`, `cancel_task`, and `delete_task` require `confirm=true`.
