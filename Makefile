COMPOSE_FILE = docker-compose.prod.yml

up:
	docker compose -f $(COMPOSE_FILE) up --build -d

# Поднять всё вместе с traefik (используется только в одной "главной" ветке)
up-with-traefik:
	docker compose -f $(COMPOSE_FILE) --profile traefik up --build -d

down:
	docker compose -f $(COMPOSE_FILE) down

restart:
	docker compose -f $(COMPOSE_FILE) restart

down-hard:
	@read -p "⚠️  Это удалит все данные! Продолжить? (y/N): " confirm && \
	if [ "$$confirm" = "y" ]; then \
		docker compose -f $(COMPOSE_FILE) down -v; \
	else \
		echo "Операция отменена."; \
	fi

logs:
	docker compose -f $(COMPOSE_FILE) logs -f --tail=100

db-generate:
	docker compose -f $(COMPOSE_FILE) exec bot pnpm --filter @app/db db:generate

db-push:
	docker compose -f $(COMPOSE_FILE) exec bot pnpm --filter @app/db db:push

db-deploy:
	docker compose -f $(COMPOSE_FILE) exec bot pnpm --filter @app/db db:deploy

studio:
	docker compose -f $(COMPOSE_FILE) exec bot pnpm --filter @app/db studio