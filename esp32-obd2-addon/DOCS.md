# ESP32 OBD2 Telemetry & WebApp — Home Assistant Add-on 🚗📊🏠

Цей додаток інтегрує автономний сервер телеметрії автомобіля **ESP32-OBD2** у ваш **Home Assistant**.

---

## 🌟 Можливості в Home Assistant

1. **🖥️ Home Assistant Ingress:** Дашборд поїздок та графіки доступні прямо в бічному меню Home Assistant.
2. **💾 Персистентна база даних:** База поїздок та телеметрії зберігається у захищеному розділі `/data/obd_data.db` і не втрачається при перезапуску чи оновленнях.
3. **🤖 Telegram Bot & Mini App:** Автоматичні сповіщення про завершені поїздки та інтерактивний Telegram WebApp.
4. **⛽ Ціни на пальне (А-95):** Моніторинг цін на АЗС WOG, UPG, OKKO, KLO, Ukrnafta з автопідрахунком вартості поїздки у гривнях.
5. **📡 Сенсори в Home Assistant:** Можливість передачі параметрів авто (швидкість, RPM, температура, напруга АКБ) у сенсори Home Assistant для створення автоматизацій.

---

## 🚀 Встановлення (Покроково)

### Крок 1: Копіювання файлів на Home Assistant

Скопіюйте папку `ha-addon/esp32-obd2` на ваш пристрій з Home Assistant у директорію `/addons/`:

- **Через розширення Samba Share:**
  - Підключіться до мережевої папки `\\homeassistant.local\addons`.
  - Створіть там папку `esp32-obd2` та скопіюйте всі файли з `ha-addon/esp32-obd2/`.

- **Через Studio Code Server / File Editor:**
  - Відкрийте VS Code Server у Home Assistant.
  - У папці `/addons/` створіть `esp32-obd2` та перенесіть файли.

- **Через SSH / Terminal:**
  ```bash
  mkdir -p /addons/esp32-obd2
  # скопіюйте файли
  ```

---

### Крок 2: Встановлення через інтерфейс Home Assistant

1. У бічному меню Home Assistant перейдіть:  
   **Налаштування (Settings)** ➡️ **Додатки (Add-ons)** ➡️ **Магазин додатків (Add-on Store)**.
2. У правому верхньому кутку натисніть **⋮ (три крапки)** ➡️ **Оновити (Check for updates)**.
3. У розділі **Локальні додатки (Local add-ons)** з'явиться **"ESP32 OBD2 Telemetry & WebApp"**.
4. Натисніть на додаток і виберіть **Встановити (Install)**. Зачекайте 1-2 хвилини, поки збереться контейнер.

---

### Крок 3: Налаштування додатку

Перейдіть на вкладку **Конфігурація (Configuration)** додатку:

```yaml
telegram_bot_token: "ВАШ_ТОКЕН_TELEGRAM_БОТА"
webapp_url: "https://your-homeassistant-domain.com:3000"
fuel_price: "82.90"
port: 3000
```

- `telegram_bot_token` — токен бота від `@BotFather` (якщо використовуєте Telegram).
- `webapp_url` — публічна HTTPS-адреса додатку (Cloudflare / Nabu Casa / Ngrok), якщо відкриваєте через кнопку бота.
- `fuel_price` — ціна за 1 літр А-95 (можна змінювати прямо з вебінтерфейсу).
- `port` — порт сервера (за замовчуванням `3000`).

---

### Крок 4: Запуск та відкриття

1. Увімкніть перемикачі:
   - ✅ **Запускати під час завантаження (Start on boot)**
   - ✅ **Сторожовий таймер (Watchdog)**
   - ✅ **Показувати на бічній панелі (Show in sidebar)**
2. Натисніть **Запустити (Start)**.
3. Натисніть **Відкрити вебінтерфейс (Open Web UI)** або оберіть **OBD2 Tracker** у лівому меню Home Assistant!

---

## 📡 Підключення прошивки ESP32 до Home Assistant

У файлі `esp32-obd2/src/main.cpp` вкажіть адресу вашого сервера Home Assistant:

- **Якщо ESP32 підключається до домашнього Wi-Fi:**
  ```cpp
  const char* serverUrlBase = "http://192.168.1.XXX:3000/api/obd";
  ```
- **Якщо через точку доступу телефону (4G/LTE):**
  Використовуйте вашу публічну адресу Home Assistant (або безкоштовний Cloudflare Tunnel / Ngrok):
  ```cpp
  const char* serverUrlBase = "https://ваш-тунель.trycloudflare.com/api/obd";
  ```

---

## 🏠 Інтеграція сенсорів у `configuration.yaml` Home Assistant

Ви можете створити сенсори автомобіля всередині Home Assistant для відображення на головному дашборді та автоматизацій.

Додайте у ваш `configuration.yaml`:

```yaml
sensor:
  - platform: rest
    name: "Pajero Telemetry"
    resource: "http://localhost:3000/api/data"
    scan_interval: 5
    json_attributes_path: "$.latest"
    json_attributes:
      - speed
      - rpm
      - temp
      - voltage
      - fuel_rate
    value_template: "{{ value_json.latest.speed | round(0) }}"
    unit_of_measurement: "km/h"

template:
  - sensor:
      - name: "Pajero Engine RPM"
        state: "{{ state_attr('sensor.pajero_telemetry', 'rpm') | round(0) }}"
        unit_of_measurement: "RPM"
        icon: "mdi:engine"

      - name: "Pajero Coolant Temp"
        state: "{{ state_attr('sensor.pajero_telemetry', 'temp') | round(0) }}"
        unit_of_measurement: "°C"
        device_class: temperature
        icon: "mdi:coolant-temperature"

      - name: "Pajero Battery Voltage"
        state: "{{ state_attr('sensor.pajero_telemetry', 'voltage') | round(1) }}"
        unit_of_measurement: "V"
        device_class: voltage
        icon: "mdi:car-battery"

      - name: "Pajero Fuel Rate"
        state: "{{ state_attr('sensor.pajero_telemetry', 'fuel_rate') | round(1) }}"
        unit_of_measurement: "L/h"
        icon: "mdi:gas-station"
```

### Приклад автоматизації (Сповіщення при перегріві двигуна):
```yaml
alias: "Pajero: Перегрів двигуна!"
trigger:
  - platform: numeric_state
    entity_id: sensor.pajero_coolant_temp
    above: 105
action:
  - service: notify.persistent_notification
    data:
      title: "⚠️ Увага: Двигун Pajero"
      message: "Температура охолоджуючої рідини досягла {{ states('sensor.pajero_coolant_temp') }}°C!"
```
