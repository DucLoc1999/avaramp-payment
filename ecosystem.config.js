module.exports = {
  apps : [{
    name: "avaramp",
    script: "./dist/server.js",     // Đường dẫn đúng bạn vừa chạy thành công
    cwd: "/mnt/code/be/avaramp", // Thư mục gốc project
    instances: 1,                   // Hoặc "max" nếu muốn chạy cluster
    exec_mode: "fork",              // "fork" phù hợp cho app thanh toán để dễ debug log
    watch: false,                   // Tắt watch ở production để tránh restart ngoài ý muốn
    max_memory_restart: "1G",       // Tự khởi động lại nếu app ngốn quá 1GB RAM
    // cron_restart: '50 19 * * *',     // Khởi động lại lúc 19:50 UTC 02:50 GTM+7 mỗi ngày
    env: {
      NODE_ENV: "production",
      PORT: 3000
    },
    error_file: "./logs/err.log",   // Lưu log lỗi
    out_file: "./logs/out.log",     // Lưu log hoạt động
    log_date_format: "YYYY-MM-DD HH:mm:ss"
  },
    {
      name: "cchain-listener",
      script: "cchain-listener/src/index.ts",
      interpreter: "npx",
      interpreter_args: "tsx",
      cwd: "/mnt/code/be/avaramp",
      instances: 1,
      exec_mode: "fork",
      watch: false,
      max_memory_restart: "200M",
      env: {
        NODE_ENV: "production"
      },
      error_file: "./logs/cchain-listener-err.log",
      out_file: "./logs/cchain-listener-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss"
    },
    {
      name: "web-be",
      script: "./dist/server.js",
      cwd: "/mnt/code/be/web-be",
      instances: 1,
      exec_mode: "fork",
      watch: false,
      max_memory_restart: "500M",
      env: {
        NODE_ENV: "production",
        PORT: 3002
      },
      error_file: "./logs/err.log",
      out_file: "./logs/out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss"
    }
  ]
}
