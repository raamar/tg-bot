up:
	docker compose up --build

up-prod:
	docker compose -f docker-compose.prod.yml up --build -d

down:
	docker compose down

restart:
	docker compose restart

down-hard:
	@read -p "⚠️  Это удалит все данные! Продолжить? (y/N): " confirm && \
	if [ "$$confirm" = "y" ]; then \
		docker compose down -v; \
	else \
		echo "Операция отменена."; \
	fi

generate:
	docker compose exec bot pnpm run generate

migrate:
	docker compose exec bot pnpm run migrate

studio:
	docker compose exec bot npx prisma studio

db-push:
	docker compose exec bot npx prisma db push

migrate-dev:
	docker compose exec bot npx prisma migrate dev --name $$(read -p "Migration name: " name && echo $$name)

migrate-deploy:
	docker compose exec bot npx prisma migrate deploy

migrate-reset:
	docker compose exec bot npx prisma migrate reset --force

seed:
	docker compose exec bot pnpm run seed

logs:
	docker compose logs -f --tail=100

