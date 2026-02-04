COMPOSE_FILE = docker-compose.prod.yml

up:
	docker compose -f $(COMPOSE_FILE) up -d

up-build-linear:
	docker compose -f $(COMPOSE_FILE) build api
	docker compose -f $(COMPOSE_FILE) build db-migrate
	docker compose -f $(COMPOSE_FILE) build bot
	docker compose -f $(COMPOSE_FILE) build partner_bot
	docker compose -f $(COMPOSE_FILE) up -d

up-build-with-traefik-linear:
	docker compose -f $(COMPOSE_FILE) --profile traefik build api
	docker compose -f $(COMPOSE_FILE) --profile traefik build db-migrate
	docker compose -f $(COMPOSE_FILE) --profile traefik build bot
	docker compose -f $(COMPOSE_FILE) --profile traefik build partner_bot
	docker compose -f $(COMPOSE_FILE) --profile traefik up -d

deploy:
	git pull
	docker compose -f $(COMPOSE_FILE) pull
	docker compose -f $(COMPOSE_FILE) up -d


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
